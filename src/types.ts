export type SheetStatus =
  | "PENDING_STATION" // 待站长签（占位中）
  | "PENDING_REGION" // 站长已签，待区域经理签
  | "SIGNED" // 双签完成，冻结并生效
  | "WITHDRAWN"; // 已撤回，占位与预算占用释放

export interface Station {
  code: string;
  name: string;
  budget: number; // 单日可承受的毛利让利预算（元/日）
  manager: string; // 站长
  regionalManager: string; // 区域经理
}

export interface Fuel {
  key: string;
  name: string;
  cost: number; // 单位成本（元/升）
}

export interface Signature {
  name: string;
  at: string;
}

/** 提交测算单时固化的守卫测算结果，签署后随单冻结 */
export interface GuardSnapshot {
  currentDayMargin: number; // 当前价首日毛利（元）
  targetDayMargin: number; // 目标价首日毛利（元）
  marginChange: number; // 首日毛利变化（元，负为减少）
  reduction: number; // 毛利减少额（元，只取负值部分）
  linePrice: number; // 成本保护线价 = 单位成本 + 保护加价（元/升）
  costHit: boolean; // 目标价低于成本保护线
  costGap: number; // 低于保护线的差额（元/升）
  budgetTotal: number; // 油站预算总额（元/日）
  budgetOccupiedOther: number; // 本单之外其他待签单已占用预算（元/日）
  budgetAvailable: number; // 剩余预算（元/日）
  budgetHit: boolean; // 减少额超过剩余预算
  budgetGap: number; // 超预算差额（元/日）
}

export interface Sheet {
  id: string;
  code: string; // 单号
  stationCode: string;
  fuelKey: string;
  currentPrice: number; // 当前价（快照）
  targetPrice: number; // 目标价
  dailyVolume: number; // 预计日销量（升/日）
  unitCost: number; // 单位成本（元/升）
  guard: GuardSnapshot;
  basis: string; // 调价依据（命中守卫时必填）
  status: SheetStatus;
  stationSign: Signature | null;
  regionSign: Signature | null;
  createdAt: string;
  frozenAt: string | null;
  // 版本链
  chainId: string; // 同一油站同一油品历次更正共用一条链
  versionNo: number; // 链内版本号
  parentId: string | null; // 更正自哪一张旧单
}

export interface DraftInput {
  stationCode: string;
  fuelKey: string;
  currentPrice: number;
  targetPrice: number;
  dailyVolume: number;
  unitCost: number;
  basis: string;
  parentId: string | null; // 非空表示对某已签单另立版本更正
}

export interface Blockage {
  id: string;
  at: string;
  action: string; // 受阻操作
  stationCode: string;
  stationName: string;
  fuelKey: string;
  fuelName: string;
  condition: string; // 命中条件
  gap: number | null; // 差额
  gapUnit: string; // 差额单位
  detail: string; // 完整说明
}

export interface PersistState {
  dataVersion: number;
  stations: Station[];
  fuels: Fuel[];
  protectionMargin: number; // 成本保护加价（元/升），保护线 = 单位成本 + 该值
  currentPrices: Record<string, number>; // 当前生效挂牌价
  sheets: Sheet[];
  blockages: Blockage[];
  seq: number;
}
