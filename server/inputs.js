import { digest } from "./db.js";
import { HttpError } from "./errors.js";
import { configuration, sourceProfile, secret } from "./config.js";

export async function limitedText(response, maxBytes = 600000) {
  if (!response.ok)
    throw new HttpError(
      502,
      "UPSTREAM_ERROR",
      `외부 응답을 받지 못했어요 (${response.status}).`,
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      await response.body.cancel?.().catch(() => {});
      throw new HttpError(
        422,
        "INPUT_TOO_LARGE",
        "입력이 허용 크기를 넘었어요. 검토 범위를 줄여주세요.",
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function collectInput(
  snapshot,
  { fetchImpl = fetch, signal, config = configuration() } = {},
) {
  const profile = sourceProfile(config);
  if (snapshot.sourceProfile && snapshot.sourceProfile.id !== profile.id)
    throw new HttpError(
      409,
      "SCM_PROFILE_CHANGED",
      "실행 시작 후 저장소 연결 설정이 변경됐어요. 새 실행을 준비해주세요.",
    );
  if (
    snapshot.source?.kind === "gitlab-immutable-diff" &&
    !snapshot.sourceProfile
  )
    throw new HttpError(
      409,
      "SCM_PROFILE_MISSING",
      "저장소 연결을 고정한 새 실행이 필요해요.",
    );
  if (snapshot.source) return snapshot.source;
  let target;
  try {
    target = new URL(snapshot.target);
  } catch {}
  if (target?.pathname.includes("/-/merge_requests/")) {
    return collectGitLab(snapshot, target, profile, { fetchImpl, signal });
  }
  const match = snapshot.target.match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/,
  );
  if (!match)
    return {
      kind: "user-provided",
      text: snapshot.goal,
      hash: digest(snapshot.goal),
      url: null,
      sha: snapshot.targetVersion,
      warning:
        "사용자가 제공한 요청만 사용했습니다. 실제 저장소·환경은 조회하지 않았습니다.",
    };
  const [, owner, repo, number] = match,
    version = snapshot.targetVersion;
  if (!profile.githubEnabled)
    throw new HttpError(
      403,
      "GITHUB_DISABLED",
      "이 배포에서는 공개 GitHub 연결을 사용하지 않아요. 설정한 GitLab MR을 입력해주세요.",
    );
  if (!/^[a-f0-9]{7,40}$/i.test(version))
    throw new HttpError(
      422,
      "COMMIT_REQUIRED",
      "GitHub PR은 7~40자리 커밋 SHA를 입력해주세요.",
    );
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "crewroom/0.5",
    "x-github-api-version": "2022-11-28",
  };
  const requestSignal = AbortSignal.any([
    signal || new AbortController().signal,
    AbortSignal.timeout(15000),
  ]);
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const pr = JSON.parse(
    await limitedText(
      await fetchImpl(`${base}/pulls/${number}`, {
        headers,
        redirect: "error",
        signal: requestSignal,
      }),
      200000,
    ),
  );
  if (
    !pr.head?.sha?.toLowerCase().startsWith(version.toLowerCase()) ||
    !/^[a-f0-9]{40}$/.test(pr.base?.sha || "") ||
    !/^[a-f0-9]{40}$/.test(pr.head?.sha || "")
  )
    throw new HttpError(
      409,
      "TARGET_MOVED",
      "PR의 현재 커밋과 요청한 SHA가 달라요. 대상 버전을 확인해주세요.",
    );
  if (pr.base.repo?.private)
    throw new HttpError(
      403,
      "PRIVATE_REPOSITORY",
      "현재 연결은 공개 저장소의 읽기 전용 검토를 지원합니다.",
    );
  // Compare immutable SHAs; never fetch a mutable .diff URL after checking the head.
  const diff = await limitedText(
    await fetchImpl(`${base}/compare/${pr.base.sha}...${pr.head.sha}`, {
      headers: { ...headers, accept: "application/vnd.github.diff" },
      redirect: "error",
      signal: requestSignal,
    }),
    400000,
  );
  const text = `PR: ${pr.title || ""}\nDescription: ${String(pr.body || "").slice(0, 12000)}\nBase: ${pr.base.sha}\nHead: ${pr.head.sha}\nDIFF:\n${diff}`;
  return {
    kind: "github-immutable-diff",
    url: snapshot.target,
    sha: pr.head.sha,
    baseSha: pr.base.sha,
    text,
    hash: digest(text),
    fetchedAt: new Date().toISOString(),
    warning:
      "공개 GitHub diff를 읽었습니다. 저장소 코드 실행·테스트·외부 변경은 수행하지 않았습니다.",
  };
}

async function collectGitLab(snapshot, target, profile, { fetchImpl, signal }) {
  if (!profile.gitlabBase)
    throw new HttpError(
      503,
      "GITLAB_NOT_CONFIGURED",
      "GitLab URL과 프로젝트를 설정해주세요.",
    );
  if (!snapshot.sourceProfile)
    throw new HttpError(
      409,
      "SCM_PROFILE_MISSING",
      "저장소 연결을 고정한 새 실행이 필요해요.",
    );
  const root = new URL(profile.gitlabBase),
    prefix = root.pathname.replace(/\/$/, "") + "/";
  const relative =
    target.origin === root.origin && target.pathname.startsWith(prefix)
      ? target.pathname.slice(prefix.length)
      : "";
  const match = relative.match(/^(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/);
  if (!match || target.username || target.password)
    throw new HttpError(
      403,
      "GITLAB_TARGET_DENIED",
      "설정한 GitLab의 MR 주소만 읽을 수 있어요.",
    );
  let project;
  try {
    project = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(
      422,
      "INVALID_TARGET",
      "GitLab 프로젝트 주소를 확인해주세요.",
    );
  }
  if (
    project.split("/").some((part) => !part || part === "." || part === "..") ||
    !profile.projects.includes(project)
  )
    throw new HttpError(
      403,
      "GITLAB_PROJECT_DENIED",
      "이 프로젝트는 현재 GitLab 연결에 등록되지 않았어요.",
    );
  if (
    snapshot.visibility !== "private" &&
    !profile.sharedProjects.includes(project)
  )
    throw new HttpError(
      403,
      "GITLAB_SHARING_DENIED",
      "팀원이 함께 열람할 수 있도록 등록한 프로젝트만 공유 업무에서 읽을 수 있어요.",
    );
  if (!/^[a-f0-9]{7,64}$/i.test(snapshot.targetVersion))
    throw new HttpError(
      422,
      "COMMIT_REQUIRED",
      "GitLab MR의 커밋 SHA를 입력해주세요.",
    );
  const token = await secret("GITLAB_TOKEN");
  if (!token)
    throw new HttpError(
      503,
      "GITLAB_NOT_CONFIGURED",
      "GitLab 읽기 토큰을 설정해주세요.",
    );
  const requestSignal = AbortSignal.any([
    signal || new AbortController().signal,
    AbortSignal.timeout(15000),
  ]);
  const headers = {
    accept: "application/json",
    "PRIVATE-TOKEN": token,
    "user-agent": "crewroom/0.5",
  };
  const base = `${profile.gitlabBase}/api/v4/projects/${encodeURIComponent(project)}`;
  const read = async (url, maxBytes) =>
    JSON.parse(
      await limitedText(
        await fetchImpl(url, {
          headers,
          redirect: "error",
          signal: requestSignal,
        }),
        maxBytes,
      ),
    );
  const mr = await read(`${base}/merge_requests/${match[2]}`, 200000);
  const sha = mr.diff_refs?.head_sha,
    baseSha = mr.diff_refs?.base_sha;
  const fullSha = (value) =>
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value || "");
  if (
    !fullSha(sha) ||
    !fullSha(baseSha) ||
    !sha.toLowerCase().startsWith(snapshot.targetVersion.toLowerCase()) ||
    (mr.sha && mr.sha.toLowerCase() !== sha.toLowerCase())
  )
    throw new HttpError(
      409,
      "TARGET_MOVED",
      "MR 커밋과 요청한 SHA가 다르거나 diff 준비가 끝나지 않았어요. 대상 버전을 확인해주세요.",
    );
  const compare = new URL(`${base}/repository/compare`);
  compare.searchParams.set("from", baseSha);
  compare.searchParams.set("to", sha);
  compare.searchParams.set("straight", "true");
  const changes = await read(compare.href, 600000),
    diffs = changes.diffs;
  if (
    !Array.isArray(diffs) ||
    changes.compare_timeout ||
    changes.overflow ||
    diffs.some(
      (d) =>
        d.too_large ||
        d.collapsed ||
        (!String(d.diff || "").trim() &&
          !d.new_file &&
          !d.deleted_file &&
          !d.renamed_file &&
          !(d.old_path && d.new_path && d.old_path !== d.new_path) &&
          !(d.a_mode && d.b_mode && d.a_mode !== d.b_mode)),
    ) ||
    String(mr.changes_count || "").includes("+") ||
    (/^\d+$/.test(String(mr.changes_count)) &&
      Number(mr.changes_count) !== diffs.length)
  )
    throw new HttpError(
      422,
      "DIFF_INCOMPLETE",
      "GitLab diff가 생략되거나 제한을 넘었어요. 검토 범위를 줄여주세요.",
    );
  const text =
    `MR: ${mr.title || ""}\nDescription: ${String(mr.description || "").slice(0, 12000)}\nProject: ${project}\nBase: ${baseSha}\nHead: ${sha}\nDIFF:\n` +
    diffs
      .map(
        (d) =>
          `diff --git a/${d.old_path} b/${d.new_path}\nMETADATA: ${JSON.stringify({ old_path: d.old_path, new_path: d.new_path, a_mode: d.a_mode ?? null, b_mode: d.b_mode ?? null, new_file: Boolean(d.new_file), deleted_file: Boolean(d.deleted_file), renamed_file: Boolean(d.renamed_file), text_diff_available: Boolean(d.diff?.trim()) })}\n${d.diff || "No textual diff was provided; only the metadata above is available."}`,
      )
      .join("\n");
  return {
    kind: "gitlab-immutable-diff",
    url: snapshot.target,
    project,
    sha,
    baseSha,
    text,
    hash: digest(text),
    fetchedAt: new Date().toISOString(),
    warning:
      "설정한 GitLab에서 고정 SHA의 diff를 읽었습니다. 바이너리 내용·저장소 코드 실행·테스트·외부 변경은 확인하지 않았습니다.",
  };
}

// Execution sources always resolve through the registered GitLab project.
export async function collectCodeInput(
  snapshot,
  { config = configuration(), fetchImpl = fetch, signal } = {},
) {
  const profile = sourceProfile(config);
  if (snapshot.sourceProfile?.id !== profile.id)
    throw new HttpError(
      409,
      "SCM_PROFILE_CHANGED",
      "저장소 설정을 고정한 새 실행이 필요해요.",
    );
  if (snapshot.source?.kind === "gitlab-code-archive") return snapshot.source;
  if (!profile.gitlabBase)
    throw new HttpError(
      503,
      "GITLAB_NOT_CONFIGURED",
      "GitLab URL을 설정해주세요.",
    );
  const root = new URL(profile.gitlabBase),
    target = new URL(snapshot.target),
    prefix = root.pathname.replace(/\/$/, "") + "/";
  if (
    target.origin !== root.origin ||
    !target.pathname.startsWith(prefix) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new HttpError(
      403,
      "GITLAB_TARGET_DENIED",
      "설정한 GitLab 프로젝트 주소가 필요해요.",
    );
  const project = decodeURIComponent(
    target.pathname
      .slice(prefix.length)
      .replace(/\/$/, "")
      .replace(/\/-\/merge_requests\/\d+$/, ""),
  );
  if (!profile.projects.includes(project))
    throw new HttpError(
      403,
      "GITLAB_PROJECT_DENIED",
      "실행을 허용한 프로젝트가 아니에요.",
    );
  if (
    snapshot.visibility !== "private" &&
    !profile.sharedProjects.includes(project)
  )
    throw new HttpError(
      403,
      "GITLAB_SHARING_DENIED",
      "공유를 허용한 프로젝트가 아니에요.",
    );
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.targetVersion))
    throw new HttpError(
      422,
      "FULL_COMMIT_REQUIRED",
      "전체 커밋 SHA가 필요해요.",
    );
  const token = await secret("GITLAB_TOKEN");
  if (!token)
    throw new HttpError(
      503,
      "GITLAB_NOT_CONFIGURED",
      "GitLab 읽기 토큰이 필요해요.",
    );
  const headers = { "PRIVATE-TOKEN": token },
    requestSignal = AbortSignal.any([
      signal || new AbortController().signal,
      AbortSignal.timeout(30000),
    ]),
    base = `${profile.gitlabBase}/api/v4/projects/${encodeURIComponent(project)}/repository`;
  const commit = JSON.parse(
    await limitedText(
      await fetchImpl(`${base}/commits/${snapshot.targetVersion}`, {
        headers,
        signal: requestSignal,
        redirect: "error",
      }),
      200000,
    ),
  );
  if (commit.id?.toLowerCase() !== snapshot.targetVersion.toLowerCase())
    throw new HttpError(
      409,
      "COMMIT_MISMATCH",
      "고정 커밋을 확인할 수 없어요.",
    );
  const response = await fetchImpl(
    `${base}/archive.tar.gz?sha=${encodeURIComponent(commit.id)}`,
    { headers, signal: requestSignal, redirect: "error" },
  );
  if (!response.ok)
    throw new HttpError(
      502,
      "ARCHIVE_UNAVAILABLE",
      "저장소 압축본을 가져오지 못했어요.",
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024)
      throw new HttpError(
        422,
        "ARCHIVE_TOO_LARGE",
        "실행 코드가 압축 크기 20MB를 넘었어요.",
      );
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const { parseArchive } = await import("../runner/archive.mjs");
  parseArchive(bytes, { gzip: true, stripRoot: true });
  return {
    kind: "gitlab-code-archive",
    url: snapshot.target,
    project,
    sha: commit.id.toLowerCase(),
    hash: digest(bytes.toString("base64")),
    archive: bytes.toString("base64"),
    fetchedAt: new Date().toISOString(),
  };
}
