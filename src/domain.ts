// 调价毛利影响双签台 —— 领域模型与测算规则

export const FUELS = ["92号汽油", "95号汽油", "98号汽油", "柴油"] as const;
export type Fuel = (typeof FUELS)[number];

export type StationCode = "chengdong" | "chengxi" | "chengnan";

export interface Station {
  code: StationCode;
  name: string;
  region: string;
  /** 日毛利减少预算上限（元/日），待签单按预占合计受其约束 */
  budget: number;
  manager: string;
  regionalManager: string;
}

export const STATIONS: Station[] = [
  { code: "chengdong", name: "城东加油站", region: "华东一区", budget: 3000, manager: "王立强", regionalManager: "李建国" },
  { code: "chengxi", name: "城西加油站", region: "华东一区", budget: 2500, manager: "赵敏", regionalManager: "李建国" },
  { code: "chengnan", name: "城南加油站", region: "华东二区", budget: 2000, manager: "周涛", regionalManager: "陈晓峰" }
];

export type OrderStatus = "pending_station" | "pending_region" | "signed" | "withdrawn";

export const STATUS_TEXT: Record<OrderStatus, string> = {
  pending_station: "待站长签署",
  pending_region: "待区域经理签署",
  signed: "已签署",
  withdrawn: "已撤回"
};

export const PENDING_STATUSES: OrderStatus[] = ["pending_station", "pending_region"];

export interface Signature {
  name: string;
  signedAt: string; // ISO
}

export interface HitCondition {
  key: "cost_protection" | "budget";
  label: string;
  /** 命中时的差额/缺口（元），用于受阻提示 */
  gap: number;
  detail: string;
}

export interface OrderDraft {
  stationCode: StationCode;
  fuel: Fuel;
  currentPrice: number;
  targetPrice: number;
  dailyVolume: number; // 预计日销量（升/日）
  unitCost: number; // 单位成本（元/升）
  basis: string; // 依据（命中红线时必填）
}

export interface PriceOrder {
  id: string;
  /** 同一业务键（油站+油品+版本链根）下的根单 id */
  rootId: string;
  /** 更正来源单 id（版本链） */
  parentId: string | null;
  /** 同一版本链上的序号，从 1 开始 */
  version: number;
  seq: number;
  code: string; // 单号 TJ-yyyyMMdd-XXXX
  stationCode: StationCode;
  fuel: Fuel;
  /** 建单时油价表快照 */
  currentPrice: number;
  targetPrice: number;
  dailyVolume: number;
  unitCost: number;
  basis: string;

  currentUnitProfit: number;
  targetUnitProfit: number;
  currentDayProfit: number;
  targetDayProfit: number;
  dayProfitChange: number; // 调价后首日毛利变化（元/日），负为减少
  budgetHold: number; // 预算预占（元/日），取减少额正值
  hits: HitCondition[]; // 建单时命中的红线条件快照

  status: OrderStatus;
  stationSign: Signature | null;
  regionSign: Signature | null;
  createdAt: string;
  signedAt: string | null;
  withdrawnAt: string | null;
  withdrawReason: string;
}

export interface BlockResult {
  blocked: true;
  /** 受阻时必须写明：油站、油品、差额及命中条件 */
  station: string;
  fuel: Fuel;
  gap: number;
  condition: string;
  message: string;
  existingOrder?: PriceOrder;
}

export interface CalcResult {
  currentUnitProfit: number;
  targetUnitProfit: number;
  currentDayProfit: number;
  targetDayProfit: number;
  dayProfitChange: number;
  budgetHold: number;
  hits: HitCondition[];
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 按预计日销量估算调价后的首日毛利变化：
 * - 单位毛利 = 价格 - 单位成本（成本保护线即单位成本，目标价 < 单位成本即穿线）
 * - 首日毛利变化 = (目标价 - 当前价) * 预计日销量
 * - 预算预占取毛利减少额的正值
 */
export function calcImpact(input: {
  currentPrice: number;
  targetPrice: number;
  dailyVolume: number;
  unitCost: number;
}): CalcResult {
  const currentUnitProfit = round2(input.currentPrice - input.unitCost);
  const targetUnitProfit = round2(input.targetPrice - input.unitCost);
  const currentDayProfit = round2(currentUnitProfit * input.dailyVolume);
  const targetDayProfit = round2(targetUnitProfit * input.dailyVolume);
  const dayProfitChange = round2((input.targetPrice - input.currentPrice) * input.dailyVolume);
  const budgetHold = round2(dayProfitChange < 0 ? -dayProfitChange : 0);

  const hits: HitCondition[] = [];
  if (input.targetPrice < input.unitCost) {
    const gap = round2(input.unitCost - input.targetPrice);
    hits.push({
      key: "cost_protection",
      label: "低于成本保护线",
      gap,
      detail: `目标价 ${input.targetPrice.toFixed(2)} 元/升低于单位成本 ${input.unitCost.toFixed(2)} 元/升，单位毛利 -${gap.toFixed(2)} 元/升`
    });
  }
  return { currentUnitProfit, targetUnitProfit, currentDayProfit, targetDayProfit, dayProfitChange, budgetHold, hits };
}

/**
 * 预算校验：同一油站全部待签单的毛利减少额合计不得超过油站日预算，
 * 返回缺口（>0 表示受阻）。excludeId 用于排除自身。
 */
export function budgetGap(
  station: Station,
  orders: PriceOrder[],
  hold: number,
  excludeId?: string
): number {
  const occupied = orders
    .filter((order) => order.stationCode === station.code && PENDING_STATUSES.includes(order.status) && order.id !== excludeId)
    .reduce((sum, order) => sum + order.budgetHold, 0);
  return round2(occupied + hold - station.budget);
}

export function findPendingFor(orders: PriceOrder[], stationCode: StationCode, fuel: Fuel): PriceOrder | undefined {
  return orders.find(
    (order) => order.stationCode === stationCode && order.fuel === fuel && PENDING_STATUSES.includes(order.status)
  );
}

export function stationOf(code: StationCode): Station {
  const station = STATIONS.find((item) => item.code === code);
  if (!station) throw new Error(`未知油站: ${code}`);
  return station;
}

export function occupiedBudget(orders: PriceOrder[], stationCode: StationCode): number {
  return round2(
    orders
      .filter((order) => order.stationCode === stationCode && PENDING_STATUSES.includes(order.status))
      .reduce((sum, order) => sum + order.budgetHold, 0)
  );
}

export function formatMoney(value: number): string {
  const rounded = round2(value);
  return `${rounded < 0 ? "-" : ""}¥${Math.abs(rounded).toFixed(2)}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
