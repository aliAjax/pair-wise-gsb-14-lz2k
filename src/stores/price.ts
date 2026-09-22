import { defineStore } from "pinia";
import {
  STATIONS,
  PENDING_STATUSES,
  calcImpact,
  budgetGap,
  findPendingFor,
  occupiedBudget,
  round2,
  stationOf,
  type BlockResult,
  type Fuel,
  type HitCondition,
  type OrderDraft,
  type PriceOrder,
  type StationCode
} from "../domain";

const STORAGE_KEY = "dfwlfront-9-price-adjust-v1";

/** 油价表：油站 -> 油品 -> 当前价（元/升） */
export type PriceBook = Record<StationCode, Record<Fuel, number>>;

interface PersistState {
  orders: PriceOrder[];
  priceBook: PriceBook;
  seq: number;
}

function defaultPriceBook(): PriceBook {
  return {
    chengdong: { "92号汽油": 7.62, "95号汽油": 8.15, "98号汽油": 9.08, 柴油: 7.18 },
    chengxi: { "92号汽油": 7.68, "95号汽油": 8.22, "98号汽油": 9.15, 柴油: 7.22 },
    chengnan: { "92号汽油": 7.55, "95号汽油": 8.08, "98号汽油": 8.99, 柴油: 7.1 }
  };
}

export type CreateResult =
  | { ok: true; order: PriceOrder }
  | ({ ok: false } & BlockResult);

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 构造内置演示数据，保证首次进入时占位、签署、版本链均可直接观察 */
function seed(priceBook: PriceBook): { orders: PriceOrder[]; seq: number } {
  const now = Date.now();
  const iso = (offsetMin: number) => new Date(now - offsetMin * 60000).toISOString();
  let seq = 0;
  const orders: PriceOrder[] = [];

  const build = (
    partial: Omit<
      PriceOrder,
      | "id"
      | "rootId"
      | "parentId"
      | "version"
      | "seq"
      | "code"
      | "currentUnitProfit"
      | "targetUnitProfit"
      | "currentDayProfit"
      | "targetDayProfit"
      | "dayProfitChange"
      | "budgetHold"
      | "hits"
    >,
    version = 1,
    rootId?: string,
    parentId: string | null = null
  ): PriceOrder => {
    seq += 1;
    const calc = calcImpact({
      currentPrice: partial.currentPrice,
      targetPrice: partial.targetPrice,
      dailyVolume: partial.dailyVolume,
      unitCost: partial.unitCost
    });
    const hits: HitCondition[] = [...calc.hits];
    const station = stationOf(partial.stationCode);
    if (PENDING_STATUSES.includes(partial.status) && calc.budgetHold > 0 && budgetGap(station, orders, calc.budgetHold) > 0) {
      const gap = budgetGap(station, orders, calc.budgetHold);
      hits.push({
        key: "budget",
        label: "超过油站预算",
        gap,
        detail: `待签单毛利减少预占合计超出日预算 ${station.budget.toFixed(2)} 元，缺口 ${gap.toFixed(2)} 元/日`
      });
    }
    const id = genId();
    const date = new Date(partial.createdAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      ...partial,
      ...calc,
      hits,
      id,
      rootId: rootId ?? id,
      parentId,
      version,
      seq,
      code: `TJ-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${String(seq).padStart(4, "0")}`
    };
  };

  // 1) 城东 92#：站长已签，待区域经理签署（占预算 ¥1,200）
  orders.push(
    build({
      stationCode: "chengdong",
      fuel: "92号汽油",
      currentPrice: priceBook.chengdong["92号汽油"],
      targetPrice: 7.5,
      dailyVolume: 10000,
      unitCost: 6.9,
      basis: "周五促销跟进竞品，预计走量提升 8%，已附竞品挂牌照片。",
      status: "pending_region",
      stationSign: { name: STATIONS[0].manager, signedAt: iso(300) },
      regionSign: null,
      createdAt: iso(320),
      signedAt: null,
      withdrawnAt: null,
      withdrawReason: ""
    })
  );

  // 2) 城西 95#：已签署版本 V1（旧数保留，价格已生效）
  const v1 = build({
    stationCode: "chengxi",
    fuel: "95号汽油",
    currentPrice: 8.35,
    targetPrice: 8.22,
    dailyVolume: 6000,
    unitCost: 7.4,
    basis: "区域月度统调。",
    status: "signed",
    stationSign: { name: STATIONS[1].manager, signedAt: iso(2 * 24 * 60 + 180) },
    regionSign: { name: STATIONS[1].regionalManager, signedAt: iso(2 * 24 * 60 + 120) },
    createdAt: iso(2 * 24 * 60 + 200),
    signedAt: iso(2 * 24 * 60 + 120),
    withdrawnAt: null,
    withdrawReason: ""
  });
  orders.push(v1);

  // 3) 城西 95#：更正版本 V2，已签署（当前价取 V1 目标价，演示版本链）
  orders.push(
    build(
      {
        stationCode: "chengxi",
        fuel: "95号汽油",
        currentPrice: 8.22,
        targetPrice: 8.28,
        dailyVolume: 6000,
        unitCost: 7.4,
        basis: "修正促销折让，回调 0.06 元/升。",
        status: "signed",
        stationSign: { name: STATIONS[1].manager, signedAt: iso(24 * 60 + 90) },
        regionSign: { name: STATIONS[1].regionalManager, signedAt: iso(24 * 60 + 30) },
        createdAt: iso(24 * 60 + 110),
        signedAt: iso(24 * 60 + 30),
        withdrawnAt: null,
        withdrawReason: ""
      },
      2,
      v1.rootId,
      v1.id
    )
  );

  // 4) 城南 柴油：待站长签署，同时命中两条红线（穿成本线 + 超预算），依据已补
  orders.push(
    build({
      stationCode: "chengnan",
      fuel: "柴油",
      currentPrice: priceBook.chengnan["柴油"],
      targetPrice: 6.82,
      dailyVolume: 9000,
      unitCost: 6.95,
      basis: "大客户车队锁价协议，月保量 270 吨，已上传合同编号 CN-2026-0317。",
      status: "pending_station",
      stationSign: null,
      regionSign: null,
      createdAt: iso(150),
      signedAt: null,
      withdrawnAt: null,
      withdrawReason: ""
    })
  );

  return { orders, seq };
}

function load(): PersistState {
  const priceBook = defaultPriceBook();
  if (typeof localStorage === "undefined") {
    const initial = seed(priceBook);
    return { orders: initial.orders, seq: initial.seq, priceBook };
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistState;
      if (Array.isArray(parsed.orders)) {
        const savedBook = ((parsed.priceBook ?? {}) as Partial<PriceBook>) as Record<
          StationCode,
          Partial<Record<Fuel, number>>
        >;
        // 合并默认油价表，避免新增油站/油品时缺键
        for (const code of Object.keys(priceBook) as StationCode[]) {
          parsed.priceBook[code] = { ...priceBook[code], ...(savedBook[code] ?? {}) };
        }
        return { orders: parsed.orders, priceBook: parsed.priceBook, seq: parsed.seq ?? parsed.orders.length };
      }
    } catch {
      // 存储损坏时回退到种子数据
    }
  }
  const initial = seed(priceBook);
  return { orders: initial.orders, seq: initial.seq, priceBook };
}

export const usePriceStore = defineStore("priceAdjust", {
  state: (): PersistState => load(),

  getters: {
    stationOrders: (state) => (stationCode: StationCode) =>
      state.orders.filter((order) => order.stationCode === stationCode),

    pendingOrders(): PriceOrder[] {
      return this.orders.filter((order) => PENDING_STATUSES.includes(order.status));
    },

    stationOccupied: (state) => (stationCode: StationCode) => occupiedBudget(state.orders, stationCode),

    /** 同油站同油品的版本链（含撤回单，按版本排序） */
    versionChainOf: (state) => (order: PriceOrder) =>
      state.orders
        .filter((item) => item.rootId === order.rootId)
        .sort((a, b) => a.version - b.version || a.seq - b.seq)
  },

  actions: {
    persist() {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ orders: this.orders, priceBook: this.priceBook, seq: this.seq })
      );
    },

    /**
     * 新建测算单：
     * 1. 同一油站同一油品仅保留一张待签单，后单必须先撤回前单并释放占位；
     * 2. 按销量估算首日毛利变化，低于成本保护线或减少额超过油站预算时必须填写依据；
     * 3. 预算以同一油站全部待签单的减少额合计校验。
     */
    createOrder(draft: OrderDraft): CreateResult {
      const station = stationOf(draft.stationCode);

      // 规则 1：待签占位互斥
      const existing = findPendingFor(this.orders, draft.stationCode, draft.fuel);
      if (existing) {
        return {
          ok: false,
          blocked: true,
          station: station.name,
          fuel: draft.fuel,
          gap: round2(existing.targetPrice - draft.targetPrice),
          condition: "同油站同油品已有待签单（占位未释放）",
          message:
            `${station.name} / ${draft.fuel} 已存在待签单 ${existing.code}（${existing.status === "pending_station" ? "待站长签署" : "待区域经理签署"}，` +
            `预占预算 ${formatHold(existing.budgetHold)}）。后单须先撤回前单并释放占位，才能再建新单。`,
          existingOrder: existing
        };
      }

      // 规则 2：毛利测算
      const calc = calcImpact(draft);
      const hits: HitCondition[] = [...calc.hits];

      // 规则 3：预算红线
      const gap = budgetGap(station, this.orders, calc.budgetHold);
      if (calc.budgetHold > 0 && gap > 0) {
        hits.push({
          key: "budget",
          label: "超过油站预算",
          gap,
          detail: `本单预占 ${formatHold(calc.budgetHold)}，叠加在签预占后超出日预算 ${station.budget.toFixed(2)} 元，缺口 ${gap.toFixed(2)} 元/日`
        });
      }

      if (hits.length > 0 && !draft.basis.trim()) {
        const hit = hits[0];
        return {
          ok: false,
          blocked: true,
          station: station.name,
          fuel: draft.fuel,
          gap: hit.gap,
          condition: hit.label,
          message:
            `${station.name} / ${draft.fuel} 命中【${hit.label}】，差额 ${hit.gap.toFixed(2)} 元` +
            (hit.key === "cost_protection" ? "/升" : "/日") +
            `：${hit.detail}。必须填写调价依据后才能送签。`
        };
      }

      this.seq += 1;
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const id = genId();
      const order: PriceOrder = {
        id,
        rootId: id,
        parentId: null,
        version: 1,
        seq: this.seq,
        code: `TJ-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${String(this.seq).padStart(4, "0")}`,
        stationCode: draft.stationCode,
        fuel: draft.fuel,
        currentPrice: round2(draft.currentPrice),
        targetPrice: round2(draft.targetPrice),
        dailyVolume: round2(draft.dailyVolume),
        unitCost: round2(draft.unitCost),
        basis: draft.basis.trim(),
        ...calc,
        hits,
        status: "pending_station",
        stationSign: null,
        regionSign: null,
        createdAt: now.toISOString(),
        signedAt: null,
        withdrawnAt: null,
        withdrawReason: ""
      };
      this.orders.unshift(order);
      this.persist();
      return { ok: true, order };
    },

    /** 撤回待签单：释放同油站同油品占位与预算预占 */
    withdrawOrder(id: string, reason: string): boolean {
      const order = this.orders.find((item) => item.id === id);
      if (!order || !PENDING_STATUSES.includes(order.status)) return false;
      order.status = "withdrawn";
      order.withdrawnAt = new Date().toISOString();
      order.withdrawReason = reason.trim() || "申请人撤回后重提";
      this.persist();
      return true;
    },

    /** 逐级签署：先站长、后区域经理；签署后冻结测算、价格和签名 */
    signOrder(id: string, role: "station" | "region", signName: string): boolean {
      const order = this.orders.find((item) => item.id === id);
      if (!order) return false;
      const sign = { name: signName.trim(), signedAt: new Date().toISOString() };
      if (role === "station" && order.status === "pending_station" && !order.stationSign) {
        order.stationSign = sign;
        order.status = "pending_region";
        this.persist();
        return true;
      }
      if (role === "region" && order.status === "pending_region" && order.stationSign && !order.regionSign) {
        order.regionSign = sign;
        order.status = "signed";
        order.signedAt = sign.signedAt;
        // 双签完成：目标价写入油价表（签署冻结，当前价随之更新）
        this.priceBook[order.stationCode][order.fuel] = order.targetPrice;
        this.persist();
        return true;
      }
      return false;
    },

    /**
     * 更正已签署测算单：另立版本，旧数原样保留。
     * 新版本以源单目标价为当前价快照，仍走站长 -> 区域经理双签与占位互斥。
     */
    createRevision(sourceId: string, draft: OrderDraft): CreateResult {
      const source = this.orders.find((item) => item.id === sourceId);
      if (!source || source.status !== "signed") {
        const station = stationOf(draft.stationCode);
        return {
          ok: false,
          blocked: true,
          station: station.name,
          fuel: draft.fuel,
          gap: 0,
          condition: "仅已签署测算单可更正",
          message: "仅已签署并冻结的测算单可以另立版本更正。"
        };
      }

      const result = this.createOrder(draft);
      if (!result.ok) return result;

      const revision = result.order;
      const chain = this.orders.filter((item) => item.rootId === source.rootId);
      revision.rootId = source.rootId;
      revision.parentId = source.id;
      revision.version = Math.max(...chain.map((item) => item.version)) + 1;
      this.persist();
      return { ok: true, order: revision };
    },

    resetDemo() {
      const priceBook = defaultPriceBook();
      const initial = seed(priceBook);
      this.orders = initial.orders;
      this.seq = initial.seq;
      this.priceBook = priceBook;
      this.persist();
    }
  }
});

function formatHold(value: number): string {
  return `${value.toFixed(2)} 元/日`;
}
