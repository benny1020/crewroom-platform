import test from "node:test";
import assert from "node:assert/strict";
import { initial } from "../src/data.js";
import {
  canReadConversation,
  memoryScopeForConversation,
} from "../src/domain.js";
import {
  initializeTeam,
  registerMember,
  switchMember,
  isTeamLead,
  canManageActor,
  canEditBinding,
  canPublishSkill,
  updateMember,
  saveDepartment,
  saveTeamSettings,
} from "../src/team-domain.js";

const seed = () => initializeTeam({ ...initial(), conversations: [] });
const registration = {
  name: "서연",
  email: "seoyeon@example.com",
  assistant: "보리",
  department: "development",
};

test("schema 8 migration retains existing personal data and creates one shared team", () => {
  const state = initial();
  state.memories.push({
    id: "private-proof",
    scope: "personal",
    owner: "minji",
  });
  initializeTeam(state);
  assert.equal(state.schema, 9);
  assert.equal(state.members.roopre.role, "lead");
  assert.equal(state.members.minji.role, "member");
  assert.equal(state.memories.at(-1).id, "private-proof");
  assert.equal(state.tasks[0].id, "T-108");
  assert.equal(state.team.departments.length, 4);
  assert.equal(state.teams, undefined);
});

test("both signup roles join the same team and receive their own private assistant", () => {
  for (const lead of [false, true]) {
    const state = seed(),
      team = state.team;
    const id = registerMember(state, {
      ...registration,
      isLead: lead ? "on" : undefined,
    });
    assert.equal(state.team, team);
    assert.equal(Object.keys(state.members).length, 3);
    assert.equal(state.members[id].role, "member");
    assert.equal(state.members[id].leadRequested, lead);
    assert.equal(state.view, "office");
    assert.equal(isTeamLead(state), false);
    assert.equal(state.profiles[id].name, "보리");
    const conversation = state.conversations.find((c) => c.actorId === id);
    assert.equal(conversation.visibility, "private");
    assert.equal(
      canReadConversation(conversation, "roopre", state.members),
      false,
    );
    assert.equal(canReadConversation(conversation, id, state.members), true);
  }
});

test("duplicate or invalid registration does not add partially created users", () => {
  const state = seed();
  for (const values of [
    { ...registration, email: "MINJI@example.com" },
    { ...registration, email: "invalid" },
    { ...registration, assistant: "" },
    { ...registration, department: "unknown" },
  ])
    assert.throws(() => registerMember(state, values));
  assert.equal(Object.keys(state.members).length, 2);
  assert.equal(Object.keys(state.profiles).length, 2);
  assert.equal(state.conversations.length, 0);
});

test("members can customize themselves but cannot manage public or other personal actors", () => {
  const state = seed();
  switchMember(state, "minji");
  assert.equal(canManageActor(state, "minji"), true);
  assert.equal(canManageActor(state, "dev"), false);
  assert.equal(canManageActor(state, "roopre"), false);
  assert.equal(canEditBinding(state, "qa"), false);
  assert.equal(canPublishSkill(state, { scope: "team" }), false);
  assert.throws(() => saveTeamSettings(state, { name: "changed" }), /팀장만/);
  assert.throws(
    () => saveDepartment(state, "qa", { name: "changed" }),
    /팀장만/,
  );
  assert.throws(
    () => updateMember(state, "minji", { role: "lead", department: "qa" }),
    /팀장만/,
  );
});

test("the last lead is protected, and a demoted lead loses management access immediately", () => {
  const state = seed();
  assert.throws(
    () =>
      updateMember(state, "roopre", {
        role: "member",
        department: "development",
      }),
    /한 명 이상/,
  );
  assert.equal(state.members.roopre.role, "lead");
  updateMember(state, "minji", { role: "lead", department: "qa" });
  updateMember(state, "roopre", { role: "member", department: "development" });
  assert.equal(isTeamLead(state), false);
  assert.throws(
    () => updateMember(state, "minji", { role: "member", department: "qa" }),
    /팀장만/,
  );
  assert.equal(state.team.audit.length, 2);
});

test("department and skill policies update the shared model without granting actor administration", () => {
  const state = seed();
  saveDepartment(state, "qa", { name: "품질", description: "제품 품질 검증" });
  saveDepartment(state, undefined, {
    name: "디자인",
    description: "사용자 경험",
  });
  assert.equal(state.team.departments.length, 5);
  assert.throws(
    () => saveDepartment(state, undefined, { name: "품질" }),
    /같은 이름/,
  );
  saveTeamSettings(state, {
    name: "제품팀",
    description: "같이 일해요",
    memberTeamSkills: "on",
  });
  switchMember(state, "minji");
  assert.equal(canEditBinding(state, "qa"), true);
  assert.equal(canPublishSkill(state, { scope: "team" }), true);
  assert.equal(canManageActor(state, "qa"), false);
  assert.equal(state.team.name, "제품팀");
});

test("membership-driven conversation rules support new users without admin access to private content", () => {
  const state = seed();
  const id = registerMember(state, {
    ...registration,
    department: "qa",
    isLead: "on",
  });
  const privateConversation = {
    actorId: "minji",
    owner: "minji",
    visibility: "private",
    department: "qa",
  };
  assert.equal(
    canReadConversation(privateConversation, id, state.members),
    false,
  );
  assert.throws(
    () =>
      memoryScopeForConversation(privateConversation, id, false, state.members),
    /FORBIDDEN/,
  );
  const departmentConversation = {
    actorId: "qa",
    owner: "minji",
    visibility: "department",
    department: "qa",
  };
  assert.equal(
    canReadConversation(departmentConversation, id, state.members),
    true,
  );
  switchMember(state, "roopre");
  updateMember(state, id, { role: "lead", department: "development" });
  assert.equal(
    canReadConversation(departmentConversation, id, state.members),
    false,
  );
});
