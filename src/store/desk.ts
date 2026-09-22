import { defineStore } from "pinia";
import { computed, reactive } from "vue";
import type {
  Blockage,
  DraftInput,
  GuardSnapshot,
  PersistState,
  Sheet,
  SheetStatus,
  Signature
} from "../types";

const STORAGE_KEY = "dfwlfront-9-dual-sign-desk";
const DATA_VERSION = 1;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatMoney(n: number): string {
  return `${n < 0 ? "-" : ""}¥${Math.abs(n).toFixed(2)}`;
}

function iso(daysAgo: number, hhmm: string): string {
  // 固定以 2026-09-22（今天）为基准生成演示时间戳
  const d = new Date(Date.UTC(2026, 8, 22) - daysAgo * 86400000);
  const [hh, mm] = hhmm.split(":");
  d.setUTCHours(Number(hh), Number(mm), 0, 0);
  return d.toISOString();
}

/**
 * 调价毛利测算（纯函数，便于在表单和签署守卫中共用）：
 * 首日毛利 = (售价 - 单位成本) × 预计日销量；毛利变化 = 目标毛利 - 当前毛利。
 */
export function evaluateGuard(params: {
  currentPrice: number;
  targetPrice: number;
  dailyVolume: number;
  unitCost: number;
  protectionMargin: number;
  budgetTotal: number;
  budgetOccupiedOther: number;
}): GuardSnapshot {
  const {
    currentPrice,
    targetPrice,
    dailyVolume,
    unitCost,
    protectionMargin,
    budgetTotal,
    budgetOccupiedOther
  } = params;
  const currentDayMargin = round2((currentPrice - unitCost) * dailyVolume);
  const targetDayMargin = round2((targetPrice - unitCost) * dailyVolume);
  const marginChange = round2(targetDayMargin - currentDayMargin);
  const reduction = round2(marginChange < 0 ? -marginChange : 0);
  const linePrice = round2(unitCost + protectionMargin);
  const costGap = round2(targetPrice < linePrice ? linePrice - targetPrice : 0);
  const budgetAvailable = round2(Math.max(0, budgetTotal - budgetOccupiedOther));
  const budgetGap = round2(reduction > budgetAvailable ? reduction - budgetAvailable : 0);
  return {
    currentDayMargin,
    targetDayMargin,
    marginChange,
    reduction,
    linePrice,
    costHit: costGap > 0,
    costGap,
    budgetTotal,
    budgetOccupiedOther: round2(budgetOccupiedOther),
    budgetAvailable,
    budgetHit: budgetGap > 0,
    budgetGap
  };
}

/* ------------------------------ 演示种子数据 ------------------------------ */

function buildSeed(): PersistState {
  const stations: PersistState["stations"] = [
    { code: "S01", name: "城东中心站", budget: 1800, manager: "王立群", regionalManager: "李建国" },
    { code: "S02", name: "滨江大道站", budget: 1200, manager: "周敏", regionalManager: "李建国" }
  ];
  const fuels: PersistState["fuels"] = [
    { key: "F92", name: "92号汽油", cost: 6.55 },
    { key: "F95", name: "95号汽油", cost: 7.02 },
    { key: "F98", name: "98号汽油", cost: 7.88 },
    { key: "F0", name: "0号柴油", cost: 6.18 }
  ];
  const protectionMargin = 0.2; // 保护线 = 单位成本 + 0.20 元/升

  // S02/92 最新已签版本是 v2（7.40），当前价取最新版本目标价
  const currentPrices: PersistState["currentPrices"] = {
    "S01/F92": 7.62,
    "S01/F0": 7.18,
    "S02/F92": 7.4
  };

  let seq = 0;
  const sheets: Sheet[] = [];
  const push = (s: Omit<Sheet, "code" | "id" | "chainId"> & { chainId?: string }) => {
    seq += 1;
    const chainId = s.chainId ?? `C${seq}`;
    sheets.push({
      ...s,
      id: `seed-${seq}`,
      code: `TJ-202609-${String(seq).padStart(3, "0")}`,
      chainId
    });
  };

  const sig = (name: string, at: string): Signature => ({ name, at });

  // 1) S01/92 首版：7.85 -> 7.62，正常让利 1495（预算内、线上方），双签生效
  push({
    stationCode: "S01",
    fuelKey: "F92",
    currentPrice: 7.85,
    targetPrice: 7.62,
    dailyVolume: 6500,
    unitCost: 6.55,
    guard: evaluateGuard({
      currentPrice: 7.85, targetPrice: 7.62, dailyVolume: 6500, unitCost: 6.55,
      protectionMargin, budgetTotal: 1800, budgetOccupiedOther: 0
    }),
    basis: "周末竞品促销跟价，维持城东片区市场份额。",
    status: "SIGNED",
    stationSign: sig("王立群", iso(4, "09:12")),
    regionSign: sig("李建国", iso(4, "10:40")),
    createdAt: iso(4, "09:05"),
    frozenAt: iso(4, "10:40"),
    versionNo: 1,
    parentId: null
  });

  // 2) S02/92 首版：7.80 -> 7.58，让利 1100（预算内），双签生效
  push({
    stationCode: "S02",
    fuelKey: "F92",
    currentPrice: 7.8,
    targetPrice: 7.58,
    dailyVolume: 5000,
    unitCost: 6.55,
    guard: evaluateGuard({
      currentPrice: 7.8, targetPrice: 7.58, dailyVolume: 5000, unitCost: 6.55,
      protectionMargin, budgetTotal: 1200, budgetOccupiedOther: 0
    }),
    basis: "滨江片区统一挂牌调整。",
    status: "SIGNED",
    stationSign: sig("周敏", iso(3, "14:02")),
    regionSign: sig("李建国", iso(3, "15:20")),
    createdAt: iso(3, "13:50"),
    frozenAt: iso(3, "15:20"),
    versionNo: 1,
    parentId: null
  });

  // 3) S01/柴油 首版：7.35 -> 7.18，让利 1105（预算内），双签生效
  push({
    stationCode: "S01",
    fuelKey: "F0",
    currentPrice: 7.35,
    targetPrice: 7.18,
    dailyVolume: 6500,
    unitCost: 6.18,
    guard: evaluateGuard({
      currentPrice: 7.35, targetPrice: 7.18, dailyVolume: 6500, unitCost: 6.18,
      protectionMargin, budgetTotal: 1800, budgetOccupiedOther: 0
    }),
    basis: "柴油批发价回落，同步下调挂牌价。",
    status: "SIGNED",
    stationSign: sig("王立群", iso(2, "08:30")),
    regionSign: sig("李建国", iso(2, "09:15")),
    createdAt: iso(2, "08:20"),
    frozenAt: iso(2, "09:15"),
    versionNo: 1,
    parentId: null
  });

  // 4) S02/92 更正版 v2：基于当前价 7.58 再降至 7.40，让利 900（预算内），双签生效（v1 即成“已被更正”）
  push({
    stationCode: "S02",
    fuelKey: "F92",
    currentPrice: 7.58,
    targetPrice: 7.4,
    dailyVolume: 5000,
    unitCost: 6.55,
    guard: evaluateGuard({
      currentPrice: 7.58, targetPrice: 7.4, dailyVolume: 5000, unitCost: 6.55,
      protectionMargin, budgetTotal: 1200, budgetOccupiedOther: 0
    }),
    basis: "晚高峰会员日二次让利，已获片区审批。",
    status: "SIGNED",
    stationSign: sig("周敏", iso(1, "16:05")),
    regionSign: sig("李建国", iso(1, "17:30")),
    createdAt: iso(1, "15:55"),
    frozenAt: iso(1, "17:30"),
    versionNo: 2,
    parentId: "seed-2",
    chainId: "C2"
  });

  // 5) S01/95 撤回单（占位已释放，不占预算）
  push({
    stationCode: "S01",
    fuelKey: "F95",
    currentPrice: 8.12,
    targetPrice: 7.99,
    dailyVolume: 3000,
    unitCost: 7.02,
    guard: evaluateGuard({
      currentPrice: 8.12, targetPrice: 7.99, dailyVolume: 3000, unitCost: 7.02,
      protectionMargin, budgetTotal: 1800, budgetOccupiedOther: 0
    }),
    basis: "拟跟降，后因库存周转正常暂缓。",
    status: "WITHDRAWN",
    stationSign: null,
    regionSign: null,
    createdAt: iso(1, "10:00"),
    frozenAt: null,
    versionNo: 1,
    parentId: null
  });

  // 6) S01/92 待站长签：7.62 -> 7.45，让利 1105；占位占用预算 1105（预算内、线上方）
  push({
    stationCode: "S01",
    fuelKey: "F92",
    currentPrice: 7.62,
    targetPrice: 7.45,
    dailyVolume: 6500,
    unitCost: 6.55,
    guard: evaluateGuard({
      currentPrice: 7.62, targetPrice: 7.45, dailyVolume: 6500, unitCost: 6.55,
      protectionMargin, budgetTotal: 1800, budgetOccupiedOther: 0
    }),
    basis: "",
    status: "PENDING_STATION",
    stationSign: null,
    regionSign: null,
    createdAt: iso(0, "08:10"),
    frozenAt: null,
    versionNo: 3,
    parentId: "seed-1",
    chainId: "C1"
  });

  // 7) S01/柴油 待站长签：7.18 -> 6.30，同时击穿成本保护线（差 0.08 元/升）并超预算，必须有依据
  push({
    stationCode: "S01",
    fuelKey: "F0",
    currentPrice: 7.18,
    targetPrice: 6.3,
    dailyVolume: 6500,
    unitCost: 6.18,
    guard: evaluateGuard({
      currentPrice: 7.18, targetPrice: 6.3, dailyVolume: 6500, unitCost: 6.18,
      protectionMargin, budgetTotal: 1800, budgetOccupiedOther: 1105
    }),
    basis: "大客户车队批量锁价合同，走量摊薄物流成本，特批低于常规保护线。",
    status: "PENDING_STATION",
    stationSign: null,
    regionSign: null,
    createdAt: iso(0, "08:40"),
    frozenAt: null,
    versionNo: 2,
    parentId: "seed-3",
    chainId: "C3"
  });

  // 8) S02/98 站长已签待区签：8.45 -> 8.22，让利 690，剩余预算 1200（预算内、线上方）
  push({
    stationCode: "S02",
    fuelKey: "F98",
    currentPrice: 8.45,
    targetPrice: 8.22,
    dailyVolume: 3000,
    unitCost: 7.88,
    guard: evaluateGuard({
      currentPrice: 8.45, targetPrice: 8.22, dailyVolume: 3000, unitCost: 7.88,
      protectionMargin, budgetTotal: 1200, budgetOccupiedOther: 0
    }),
    basis: "",
    status: "PENDING_REGION",
    stationSign: sig("周敏", iso(0, "09:05")),
    regionSign: null,
    createdAt: iso(0, "08:50"),
    frozenAt: null,
    versionNo: 1,
    parentId: null
  });

  return {
    dataVersion: DATA_VERSION,
    stations,
    fuels,
    protectionMargin,
    currentPrices,
    sheets,
    blockages: [],
    seq
  };
}

/* --------------------------------- Store --------------------------------- */

export const priceKey = (stationCode: string, fuelKey: string) => `${stationCode}/${fuelKey}`;
const PENDING: SheetStatus[] = ["PENDING_STATION", "PENDING_REGION"];

function hydrate(): PersistState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistState;
      if (parsed && parsed.dataVersion === DATA_VERSION && Array.isArray(parsed.sheets)) {
        return parsed;
      }
    } catch {
      /* 数据损坏时回落到演示数据 */
    }
  }
  return buildSeed();
}

export const useDeskStore = defineStore("dual-sign-desk", () => {
  const state = reactive<PersistState>(hydrate());

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const stationMap = computed(() =>
    Object.fromEntries(state.stations.map((s) => [s.code, s]))
  );
  const fuelMap = computed(() =>
    Object.fromEntries(state.fuels.map((f) => [f.key, f]))
  );

  const pendingSheets = computed(() =>
    state.sheets.filter((s) => PENDING.includes(s.status))
  );

  /** 油站预算占用：仅待签单按毛利减少额占位 */
  const budgetOccupied = computed<Record<string, number>>(() => {
    const acc: Record<string, number> = {};
    for (const s of pendingSheets.value) {
      acc[s.stationCode] = round2((acc[s.stationCode] ?? 0) + s.guard.reduction);
    }
    return acc;
  });

  const occupiedOf = (stationCode: string, exceptId?: string) =>
    round2(
      pendingSheets.value
        .filter((s) => s.stationCode === stationCode && s.id !== exceptId)
        .reduce((sum, s) => sum + s.guard.reduction, 0)
    );

  const pendingOf = (stationCode: string, fuelKey: string) =>
    pendingSheets.value.find((s) => s.stationCode === stationCode && s.fuelKey === fuelKey) ?? null;

  /** 链内最新已签版本 id：用于判定旧版本“已被更正”及当前价来源 */
  const latestSignedByChain = computed<Record<string, Sheet | undefined>>(() => {
    const map: Record<string, Sheet> = {};
    for (const s of state.sheets) {
      if (s.status === "SIGNED") {
        const cur = map[s.chainId];
        if (!cur || s.versionNo > cur.versionNo) map[s.chainId] = s;
      }
    }
    return map;
  });

  const effectiveVersionOf = (s: Sheet): Sheet | undefined =>
    latestSignedByChain.value[s.chainId];

  const isSuperseded = (s: Sheet) => {
    if (s.status !== "SIGNED") return false;
    return effectiveVersionOf(s)?.id !== s.id;
  };

  const nextVersionNo = (chainId: string) =>
    state.sheets.filter((s) => s.chainId === chainId).reduce((m, s) => Math.max(m, s.versionNo), 0) + 1;

  function addBlockage(
    b: Omit<Blockage, "id" | "at"> & { at?: string }
  ) {
    state.blockages.unshift({
      ...b,
      id: crypto.randomUUID(),
      at: b.at ?? new Date().toISOString()
    });
    persist();
  }

  function stationFuelNames(stationCode: string, fuelKey: string) {
    return {
      stationName: stationMap.value[stationCode]?.name ?? stationCode,
      fuelName: fuelMap.value[fuelKey]?.name ?? fuelKey
    };
  }

  /**
   * 提交测算单：
   * 1. 同一油站同一油品已有待签单 -> 硬阻断（先撤回前单并释放占位）
   * 2. 击穿成本保护线或毛利减少额超出油站剩余预算 -> 必须填写依据，否则阻断
   */
  function submitDraft(draft: DraftInput): { ok: boolean; sheet?: Sheet } {
    const { stationName, fuelName } = stationFuelNames(draft.stationCode, draft.fuelKey);
    const station = stationMap.value[draft.stationCode];

    const conflict = pendingOf(draft.stationCode, draft.fuelKey);
    if (conflict) {
      addBlockage({
        action: "新建测算单",
        stationCode: draft.stationCode,
        stationName,
        fuelKey: draft.fuelKey,
        fuelName,
        condition: `同一油站同一油品已有待签单 ${conflict.code}（占位中）`,
        gap: conflict.guard.reduction,
        gapUnit: "元/日（前单占用预算）",
        detail:
          `${stationName} / ${fuelName}：前单 ${conflict.code} 正处于「${statusLabel(conflict.status)}」，` +
          `占用毛利预算 ${formatMoney(conflict.guard.reduction)}/日。后单须先撤回前单并释放占位后方可提交。`
      });
      return { ok: false };
    }

    if (!station) return { ok: false };
    const occupiedOther = occupiedOf(draft.stationCode);
    const guard = evaluateGuard({
      currentPrice: draft.currentPrice,
      targetPrice: draft.targetPrice,
      dailyVolume: draft.dailyVolume,
      unitCost: draft.unitCost,
      protectionMargin: state.protectionMargin,
      budgetTotal: station.budget,
      budgetOccupiedOther: occupiedOther
    });

    if (guard.costHit || guard.budgetHit) {
      const conds: string[] = [];
      if (guard.costHit)
        conds.push(`目标价低于成本保护线 ${guard.linePrice.toFixed(2)}（差 ${guard.costGap.toFixed(2)} 元/升）`);
      if (guard.budgetHit)
        conds.push(
          `毛利减少 ${formatMoney(guard.reduction)}/日超出油站剩余预算 ` +
          `${formatMoney(guard.budgetAvailable)}/日（差 ${formatMoney(guard.budgetGap)}/日）`
        );
      if (!draft.basis.trim()) {
        addBlockage({
          action: "新建测算单",
          stationCode: draft.stationCode,
          stationName,
          fuelKey: draft.fuelKey,
          fuelName,
          condition: conds.join("；"),
          gap: guard.costHit ? guard.costGap : guard.budgetGap,
          gapUnit: guard.costHit ? "元/升（保护线差额）" : "元/日（超预算差额）",
          detail:
            `${stationName} / ${fuelName}：命中条件「${conds.join("；")}」，必须填写调价依据后方可提交双签。`
        });
        return { ok: false };
      }
    }

    // 更正必须源自同油站同油品的已签冻结单
    let chainId = `C-${draft.stationCode}-${draft.fuelKey}-${crypto.randomUUID().slice(0, 8)}`;
    let versionNo = 1;
    if (draft.parentId) {
      const parent = state.sheets.find((s) => s.id === draft.parentId);
      if (!parent || parent.status !== "SIGNED" ||
        parent.stationCode !== draft.stationCode || parent.fuelKey !== draft.fuelKey) {
        addBlockage({
          action: "更正立版",
          stationCode: draft.stationCode,
          stationName,
          fuelKey: draft.fuelKey,
          fuelName,
          condition: "更正源单不存在或不是同油站同油品的已签冻结单",
          gap: null,
          gapUnit: "",
          detail: `${stationName} / ${fuelName}：只能对双签完成并冻结的旧单另立版本。`
        });
        return { ok: false };
      }
      chainId = parent.chainId;
      versionNo = nextVersionNo(chainId);
    }

    state.seq += 1;
    const sheet: Sheet = {
      id: crypto.randomUUID(),
      code: `TJ-202609-${String(state.seq).padStart(3, "0")}`,
      stationCode: draft.stationCode,
      fuelKey: draft.fuelKey,
      currentPrice: round2(draft.currentPrice),
      targetPrice: round2(draft.targetPrice),
      dailyVolume: draft.dailyVolume,
      unitCost: round2(draft.unitCost),
      guard,
      basis: draft.basis.trim(),
      status: "PENDING_STATION",
      stationSign: null,
      regionSign: null,
      createdAt: new Date().toISOString(),
      frozenAt: null,
      chainId,
      versionNo,
      parentId: draft.parentId
    };
    state.sheets.unshift(sheet);
    persist();
    return { ok: true, sheet };
  }

  /** 撤回待签单：释放占位与预算占用，任何待签阶段都可撤回 */
  function withdraw(id: string): boolean {
    const sheet = state.sheets.find((s) => s.id === id);
    if (!sheet) return false;
    const { stationName, fuelName } = stationFuelNames(sheet.stationCode, sheet.fuelKey);
    if (!PENDING.includes(sheet.status)) {
      addBlockage({
        action: "撤回测算单",
        stationCode: sheet.stationCode,
        stationName,
        fuelKey: sheet.fuelKey,
        fuelName,
        condition: `单据 ${sheet.code} 已${sheet.status === "SIGNED" ? "双签冻结" : "终结"}，不可撤回`,
        gap: null,
        gapUnit: "",
        detail:
          `${stationName} / ${fuelName}：${sheet.code} 状态为「${statusLabel(sheet.status)}」。` +
          `双签后的测算、价格与签名已冻结，只能另立版本更正。`
      });
      return false;
    }
    sheet.status = "WITHDRAWN";
    persist(); // 预算占用与占位随 pendingSheets 计算自动释放
    return true;
  }

  /** 站长签署（逐级第一签） */
  function signStation(id: string): boolean {
    const sheet = state.sheets.find((s) => s.id === id);
    if (!sheet) return false;
    const { stationName, fuelName } = stationFuelNames(sheet.stationCode, sheet.fuelKey);
    if (sheet.status !== "PENDING_STATION") {
      addBlockage({
        action: "站长签署",
        stationCode: sheet.stationCode,
        stationName,
        fuelKey: sheet.fuelKey,
        fuelName,
        condition: `单据 ${sheet.code} 不在「待站长签」状态`,
        gap: null,
        gapUnit: "",
        detail: `${stationName} / ${fuelName}：当前状态「${statusLabel(sheet.status)}」，须由站长先签。`
      });
      return false;
    }
    const name = stationMap.value[sheet.stationCode]?.manager ?? "站长";
    sheet.stationSign = { name, at: new Date().toISOString() };
    sheet.status = "PENDING_REGION";
    persist(); // 仍占位，预算不释放
    return true;
  }

  /** 区域经理签署（逐级第二签）：双签完成即冻结并按目标价更新当前价 */
  function signRegion(id: string): boolean {
    const sheet = state.sheets.find((s) => s.id === id);
    if (!sheet) return false;
    const { stationName, fuelName } = stationFuelNames(sheet.stationCode, sheet.fuelKey);
    if (sheet.status !== "PENDING_REGION" || !sheet.stationSign) {
      addBlockage({
        action: "区域经理签署",
        stationCode: sheet.stationCode,
        stationName,
        fuelKey: sheet.fuelKey,
        fuelName,
        condition: `单据 ${sheet.code} 尚未完成站长签署`,
        gap: null,
        gapUnit: "",
        detail:
          `${stationName} / ${fuelName}：双签须逐级进行，站长未签署前区域经理不能签署。`
      });
      return false;
    }
    const name = stationMap.value[sheet.stationCode]?.regionalManager ?? "区域经理";
    sheet.regionSign = { name, at: new Date().toISOString() };
    sheet.status = "SIGNED";
    sheet.frozenAt = new Date().toISOString();
    state.currentPrices[priceKey(sheet.stationCode, sheet.fuelKey)] = sheet.targetPrice;
    persist(); // 离开待签池，预算占位自动释放
    return true;
  }

  function setBudget(code: string, budget: number) {
    const s = state.stations.find((x) => x.code === code);
    if (s && Number.isFinite(budget) && budget >= 0) {
      s.budget = round2(budget);
      persist();
    }
  }

  function setProtectionMargin(v: number) {
    if (Number.isFinite(v) && v >= 0) {
      state.protectionMargin = round2(v);
      persist();
    }
  }

  function clearBlockages() {
    state.blockages = [];
    persist();
  }

  function resetDemo() {
    const seed = buildSeed();
    Object.assign(state, seed);
    persist();
  }

  return {
    state,
    stationMap,
    fuelMap,
    pendingSheets,
    budgetOccupied,
    occupiedOf,
    pendingOf,
    latestSignedByChain,
    effectiveVersionOf,
    isSuperseded,
    nextVersionNo,
    submitDraft,
    withdraw,
    signStation,
    signRegion,
    setBudget,
    setProtectionMargin,
    clearBlockages,
    resetDemo,
    persist
  };
});

export function statusLabel(status: SheetStatus): string {
  switch (status) {
    case "PENDING_STATION":
      return "待站长签";
    case "PENDING_REGION":
      return "待区域经理签";
    case "SIGNED":
      return "双签冻结";
    case "WITHDRAWN":
      return "已撤回";
  }
}
