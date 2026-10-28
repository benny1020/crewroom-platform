/** Intrinsic bitmap coordinates only; visual dimensions belong to index.css. */
export type AtlasRect = readonly [number, number, number, number];
export const crewroomCharacters = {
  mimi: { name: "미미", portrait: "pom-portrait-v1.webp" },
  rururu: { name: "루루루", portrait: "rururu-portrait-v1.webp" },
  cloud: { name: "구름", rect: [12, 32, 365, 365] },
  fennec: { name: "사막여우", rect: [412, 24, 405, 373] },
  otter: { name: "수달", rect: [832, 64, 400, 333] },
  turtle: { name: "거북이", rect: [1235, 70, 386, 327] },
  capybara: { name: "카피바라", rect: [1634, 65, 349, 332] },
  corgi: { name: "코기", rect: [16, 412, 374, 371] },
  penguin: { name: "펭귄", rect: [396, 407, 405, 376] },
  hedgehog: { name: "고슴도치", rect: [817, 427, 407, 356] },
  fox: { name: "여우", rect: [1240, 419, 371, 364] },
  rabbit: { name: "토끼", rect: [1638, 408, 345, 375] },
} as const;
export type CrewroomCharacterId = keyof typeof crewroomCharacters;
export function crewroomCharacterId(value: unknown): CrewroomCharacterId | null {
  if (value === "pom") return "mimi";
  if (value === "default") return "cloud";
  return typeof value === "string" && Object.hasOwn(crewroomCharacters, value)
    ? value as CrewroomCharacterId : null;
}
export const crewroomSceneLabels = {
  ready: "대기", coding: "코딩", investigating: "자료 확인", testing: "검사",
  review: "검토", celebrating: "완료", question: "질문", writing: "기록",
  queued: "차례 대기", planning: "계획", paused: "휴식", blocked: "문제 확인",
} as const;
export type CrewroomScene = keyof typeof crewroomSceneLabels;
export const crewroomDiaryRects: Record<"mimi" | "rururu" | "otter", Record<CrewroomScene, AtlasRect>> = {
  mimi: {
    ready:[12,25,345,350], coding:[374,28,350,347], investigating:[734,25,352,345],
    testing:[12,382,345,350], review:[390,390,330,342], celebrating:[735,383,351,349],
    question:[20,735,342,320], writing:[376,738,345,328], queued:[725,747,361,311],
    planning:[16,1070,347,340], paused:[390,1071,310,336], blocked:[723,1067,363,344],
  },
  rururu: {
    ready:[12,18,350,357], coding:[375,30,345,345], investigating:[724,30,362,345],
    testing:[8,376,350,342], review:[385,374,330,344], celebrating:[725,380,361,342],
    question:[20,719,320,330], writing:[380,736,330,315], queued:[735,782,341,260],
    planning:[15,1047,347,365], paused:[390,1070,292,335], blocked:[697,1068,389,347],
  },
  otter: {
    ready:[8,45,357,330], coding:[374,55,346,317], investigating:[730,60,350,320],
    testing:[35,396,330,333], review:[397,405,310,324], celebrating:[732,395,347,334],
    question:[20,742,335,317], writing:[391,747,317,310], queued:[735,770,345,290],
    planning:[26,1071,344,330], paused:[415,1090,288,310], blocked:[707,1080,373,321],
  },
};
