import { departments } from "./data.js";

// One shared team. This browser prototype models roles, not authentication.
export function initializeTeam(state) {
  state.team ||= {
    name: "제품개발팀",
    description: "개발부터 운영과 QA까지, 함께 이어가는 팀",
    departments: structuredClone(departments),
    memberTeamSkills: false,
    audit: [],
  };
  state.members ||= {
    roopre: {
      id: "roopre",
      name: "로프레",
      email: "roopre@example.com",
      role: "lead",
      department: "development",
    },
    minji: {
      id: "minji",
      name: "민지",
      email: "minji@example.com",
      role: "member",
      department: "qa",
    },
  };
  state.adminTab ||= "overview";
  state.signupDraft ||= {};
  if (!state.members[state.user] || !state.profiles[state.user])
    state.user = "roopre";
  state.schema = 9;
  return state;
}

export const membership = (state, userId = state.user) => state.members[userId];
export const isTeamLead = (state) => membership(state)?.role === "lead";
export const canEditTeamSkills = (state) =>
  Boolean(
    membership(state) && (isTeamLead(state) || state.team.memberTeamSkills),
  );
export const canManageActor = (state, key) =>
  key === state.user ||
  (state.agents.some((a) => a.id === key) && isTeamLead(state));
export const canEditBinding = (state, key) =>
  key === state.user ||
  (state.agents.some((a) => a.id === key) && canEditTeamSkills(state));
export const canPublishSkill = (state, skill) =>
  skill.scope === "personal"
    ? skill.owner === state.user
    : canEditTeamSkills(state) ||
      state.skillStewards?.[skill.id] === state.user;

function requireLead(state) {
  if (!isTeamLead(state)) throw new Error("팀장만 팀 설정을 변경할 수 있어요.");
}

export function auditTeam(state, type, detail) {
  state.team.audit.unshift({
    id: crypto.randomUUID(),
    actor: membership(state).name,
    type,
    detail,
    at: new Date().toISOString(),
  });
  state.team.audit = state.team.audit.slice(0, 100);
}

export function registerMember(state, values) {
  const name = String(values.name || "").trim();
  const email = String(values.email || "")
    .trim()
    .toLowerCase();
  const assistant = String(values.assistant || "").trim();
  if (!name || name.length > 30)
    throw new Error("이름을 30자 이내로 입력해주세요.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("이메일 형식을 확인해주세요.");
  if (
    Object.values(state.members).some(
      (member) => member.email.toLowerCase() === email,
    )
  )
    throw new Error(
      "이미 가입한 이메일이에요. 상단에서 시연 사용자를 전환해주세요.",
    );
  if (!assistant || assistant.length > 16)
    throw new Error("개인 비서 이름을 16자 이내로 입력해주세요.");
  if (
    !state.team.departments.some(
      (department) => department.id === values.department,
    )
  )
    throw new Error("소속 부서를 선택해주세요.");
  const id = `u-${crypto.randomUUID()}`,
    lead = values.isLead === "on";
  state.members[id] = {
    id,
    name,
    email,
    role: "member",
    leadRequested: lead,
    department: values.department,
  };
  state.profiles[id] = {
    owner: name,
    name: assistant,
    color: lead ? "blue" : "purple",
    character: lead ? "fox" : "rabbit",
    personality: "세심한 업무 파트너",
    catchphrase: "필요한 맥락은 제가 챙겨둘게요.",
    role: `${name}님의 업무 파트너`,
    style: "핵심부터 간결하게",
    harness: "균형",
    runtime: "hermes",
    instruction: "맡긴 일을 정리하고, 결과와 필요한 근거를 함께 알려줘.",
    skills:
      values.department === "qa"
        ? ["regression", "review", "weekly"]
        : ["meeting", "bug", "release"],
  };
  const conversationId = `c-${id}-personal`;
  state.conversations.push({
    id: conversationId,
    actorId: id,
    owner: id,
    title: "내 비서와 첫 대화",
    visibility: "private",
    department: values.department,
    createdAt: new Date().toISOString(),
  });
  state.messages[conversationId] = [
    {
      author: assistant,
      kind: "agent",
      text: "함께할 준비가 됐어요. 업무를 맡기거나 기억할 내용을 알려주세요. (목업 응답)",
    },
  ];
  switchMember(state, id);
  state.signupDraft = {};
  auditTeam(
    state,
    "구성원 참여",
    `${name}님이 팀원으로 참여했어요.${lead ? " 팀장 권한을 요청했어요." : ""}`,
  );
  return id;
}

export function switchMember(state, id) {
  if (!state.members[id] || !state.profiles[id])
    throw new Error("가입한 구성원을 찾지 못했어요.");
  state.user = id;
  Object.assign(state, {
    view: "office",
    adminTab: "overview",
    agentTab: "chat",
    filter: "all",
    memoryScope: "all",
    memoryAgent: id,
    memoryQuery: "",
    search: "",
    skillTarget: id,
  });
}

export function updateMember(state, id, values) {
  requireLead(state);
  const member = state.members[id];
  if (!member || !["lead", "member"].includes(values.role))
    throw new Error("구성원의 역할을 확인해주세요.");
  if (
    !state.team.departments.some(
      (department) => department.id === values.department,
    )
  )
    throw new Error("구성원의 부서를 확인해주세요.");
  if (
    member.role === "lead" &&
    values.role !== "lead" &&
    Object.values(state.members).filter((entry) => entry.role === "lead")
      .length === 1
  )
    throw new Error(
      "팀장은 한 명 이상 필요해요. 다른 구성원을 먼저 팀장으로 지정해주세요.",
    );
  Object.assign(member, { role: values.role, department: values.department });
  if (values.role === "lead") member.leadRequested = false;
  auditTeam(
    state,
    "역할·부서 변경",
    `${member.name}님의 역할과 부서를 저장했어요.`,
  );
}

export function saveDepartment(state, id, values) {
  requireLead(state);
  const name = String(values.name || "").trim(),
    description = String(values.description || "").trim();
  if (!name || name.length > 20 || description.length > 80)
    throw new Error("부서 이름은 20자, 설명은 80자 이내로 입력해주세요.");
  if (
    state.team.departments.some(
      (entry) => entry.name === name && entry.id !== id,
    )
  )
    throw new Error("같은 이름의 부서가 있어요.");
  const department = id
    ? state.team.departments.find((entry) => entry.id === id)
    : null;
  if (id && !department) throw new Error("부서를 찾지 못했어요.");
  if (department) Object.assign(department, { name, description });
  else
    state.team.departments.push({
      id: `dept-${crypto.randomUUID().slice(0, 8)}`,
      name,
      description,
      icon: "users-round",
    });
  auditTeam(
    state,
    id ? "부서 수정" : "부서 추가",
    `${name} 부서를 ${id ? "수정" : "추가"}했어요.`,
  );
}

export function saveTeamSettings(state, values) {
  requireLead(state);
  const name = String(values.name || "").trim(),
    description = String(values.description || "").trim();
  if (!name || name.length > 30 || description.length > 120)
    throw new Error("팀 이름은 30자, 소개는 120자 이내로 입력해주세요.");
  Object.assign(state.team, {
    name,
    description,
    memberTeamSkills: values.memberTeamSkills === "on",
  });
  auditTeam(
    state,
    "팀 설정 변경",
    "팀 이름·소개와 공용 스킬 편집 정책을 저장했어요.",
  );
}
