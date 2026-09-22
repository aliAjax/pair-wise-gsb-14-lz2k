<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  FUELS,
  STATIONS,
  PENDING_STATUSES,
  STATUS_TEXT,
  calcImpact,
  budgetGap,
  formatDateTime,
  formatMoney,
  occupiedBudget,
  round2,
  stationOf,
  type Fuel,
  type HitCondition,
  type OrderStatus,
  type PriceOrder,
  type StationCode
} from "./domain";
import { usePriceStore } from "./stores/price";

const store = usePriceStore();

/** 各油站各油品单位成本参考（可在表单中修改） */
const COST_BOOK: Record<StationCode, Record<Fuel, number>> = {
  chengdong: { "92号汽油": 6.9, "95号汽油": 7.4, "98号汽油": 8.1, 柴油: 6.6 },
  chengxi: { "92号汽油": 6.95, "95号汽油": 7.4, "98号汽油": 8.05, 柴油: 6.65 },
  chengnan: { "92号汽油": 6.85, "95号汽油": 7.35, "98号汽油": 8.0, 柴油: 6.95 }
};

const form = reactive({
  stationCode: STATIONS[0].code as StationCode,
  fuel: FUELS[0] as Fuel,
  currentPrice: "",
  targetPrice: "",
  dailyVolume: "",
  unitCost: "",
  basis: ""
});

const revision = ref<PriceOrder | null>(null);
const blocker = ref<UiBlock | null>(null);
const withdrawReason = ref("后单重提，撤回前单并释放占位");
const signNames = reactive<Record<string, string>>({});
const statusFilter = ref<"all" | OrderStatus>("all");
const stationFilter = ref<"all" | StationCode>("all");

interface UiBlock {
  station: string;
  fuel: string;
  gap: number;
  gapUnit: string;
  condition: string;
  message: string;
  existing?: PriceOrder;
}

const stations = STATIONS;
const fuels = FUELS;

function syncFromMaster() {
  if (revision.value) return;
  form.currentPrice = String(store.priceBook[form.stationCode][form.fuel]);
  form.unitCost = String(COST_BOOK[form.stationCode][form.fuel]);
}

function resetForm() {
  revision.value = null;
  blocker.value = null;
  form.targetPrice = "";
  form.dailyVolume = "";
  form.basis = "";
  syncFromMaster();
}

function toNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

const parsed = computed(() => ({
  currentPrice: toNumber(form.currentPrice),
  targetPrice: toNumber(form.targetPrice),
  dailyVolume: toNumber(form.dailyVolume),
  unitCost: toNumber(form.unitCost)
}));

const live = computed(() => {
  const p = parsed.value;
  if ([p.currentPrice, p.targetPrice, p.dailyVolume, p.unitCost].some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return calcImpact(p);
});

const formStation = computed(() => stationOf(form.stationCode));

const liveBudgetGap = computed(() => {
  if (!live.value) return 0;
  return Math.max(0, budgetGap(formStation.value, store.orders, live.value.budgetHold));
});

const liveHits = computed<HitCondition[]>(() => {
  if (!live.value) return [];
  const hits = [...live.value.hits];
  if (live.value.budgetHold > 0 && liveBudgetGap.value > 0) {
    hits.push({
      key: "budget",
      label: "超过油站预算",
      gap: liveBudgetGap.value,
      detail: `本单预占 ${live.value.budgetHold.toFixed(2)} 元/日，叠加在签预占后超出日预算 ${formStation.value.budget.toFixed(2)} 元，缺口 ${liveBudgetGap.value.toFixed(2)} 元/日`
    });
  }
  return hits;
});

const basisRequired = computed(() => liveHits.value.length > 0);

function buildBlock(err: { station: string; fuel: Fuel; gap: number; condition: string; message: string; existingOrder?: PriceOrder }): UiBlock {
  const isCost = err.condition.includes("成本");
  return {
    station: err.station,
    fuel: err.fuel,
    gap: err.gap,
    gapUnit: isCost ? "元/升" : "元/日",
    condition: err.condition,
    message: err.message,
    existing: err.existingOrder
  };
}

function validateDraft(): UiBlock | null {
  const p = parsed.value;
  const stationName = formStation.value.name;
  const invalid = (label: string): UiBlock => ({
    station: stationName,
    fuel: form.fuel,
    gap: 0,
    gapUnit: "",
    condition: "表单校验未通过",
    message: `${label}必须为大于 0 的有效数字，请检查后重新送签。`
  });
  if (!Number.isFinite(p.currentPrice) || p.currentPrice <= 0) return invalid("当前价");
  if (!Number.isFinite(p.targetPrice) || p.targetPrice <= 0) return invalid("目标价");
  if (!Number.isFinite(p.dailyVolume) || p.dailyVolume <= 0) return invalid("预计日销量");
  if (!Number.isFinite(p.unitCost) || p.unitCost <= 0) return invalid("单位成本");
  if (round2(p.targetPrice) === round2(p.currentPrice)) {
    return {
      station: stationName,
      fuel: form.fuel,
      gap: 0,
      gapUnit: "",
      condition: "无调价幅度",
      message: "目标价与当前价一致，首日毛利变化为 0，无需发起测算双签。"
    };
  }
  return null;
}

function draftPayload() {
  const p = parsed.value;
  return {
    stationCode: form.stationCode,
    fuel: form.fuel,
    currentPrice: p.currentPrice,
    targetPrice: p.targetPrice,
    dailyVolume: p.dailyVolume,
    unitCost: p.unitCost,
    basis: form.basis
  };
}

function submitDraft() {
  const invalid = validateDraft();
  if (invalid) {
    blocker.value = invalid;
    return;
  }
  const result = revision.value
    ? store.createRevision(revision.value.id, draftPayload())
    : store.createOrder(draftPayload());
  if (!result.ok) {
    blocker.value = buildBlock(result);
    return;
  }
  resetForm();
}

/** 后单规则：撤回前单、释放占位后自动重提当前测算 */
function withdrawAndResubmit() {
  const existing = blocker.value?.existing;
  if (!existing) return;
  store.withdrawOrder(existing.id, withdrawReason.value);
  blocker.value = null;
  submitDraft();
}

function sign(order: PriceOrder, role: "station" | "region") {
  const station = stationOf(order.stationCode);
  const fallback = role === "station" ? station.manager : station.regionalManager;
  const name = signNames[`${role}-${order.id}`]?.trim() || fallback;
  store.signOrder(order.id, role, name);
}

function withdraw(order: PriceOrder) {
  const reason = window.prompt(`撤回 ${order.code} 将释放 ${stationOf(order.stationCode).name} / ${order.fuel} 的待签占位，请填写撤回原因：`, "申请人撤回后重提");
  if (reason === null) return;
  store.withdrawOrder(order.id, reason);
}

function startRevision(order: PriceOrder) {
  revision.value = order;
  blocker.value = null;
  form.stationCode = order.stationCode;
  form.fuel = order.fuel;
  form.currentPrice = String(order.targetPrice); // 更正以源单生效价为当前价快照
  form.targetPrice = String(order.targetPrice);
  form.dailyVolume = String(order.dailyVolume);
  form.unitCost = String(order.unitCost);
  form.basis = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/** 撤回单数据复用：重新发起普通新单（当前价取油价表现值） */
function reuseWithdrawn(order: PriceOrder) {
  revision.value = null;
  blocker.value = null;
  form.stationCode = order.stationCode;
  form.fuel = order.fuel;
  form.currentPrice = String(store.priceBook[order.stationCode][order.fuel]);
  form.targetPrice = String(order.targetPrice);
  form.dailyVolume = String(order.dailyVolume);
  form.unitCost = String(order.unitCost);
  form.basis = order.basis;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const filteredOrders = computed(() =>
  [...store.orders]
    .filter((order) => (statusFilter.value === "all" ? true : order.status === statusFilter.value))
    .filter((order) => (stationFilter.value === "all" ? true : order.stationCode === stationFilter.value))
    .sort((a, b) => b.seq - a.seq)
);

const pendingCount = computed(() => store.orders.filter((order) => PENDING_STATUSES.includes(order.status)).length);
const signedCount = computed(() => store.orders.filter((order) => order.status === "signed").length);

const totalHold = computed(() =>
  round2(store.orders.filter((order) => PENDING_STATUSES.includes(order.status)).reduce((sum, order) => sum + order.budgetHold, 0))
);
const totalBudget = computed(() => STATIONS.reduce((sum, station) => sum + station.budget, 0));
const chainCount = computed(() => {
  const roots = new Map<string, number>();
  for (const order of store.orders) roots.set(order.rootId, (roots.get(order.rootId) ?? 0) + 1);
  return [...roots.values()].filter((count) => count > 1).length;
});

const tabs: { key: "all" | OrderStatus; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending_station", label: STATUS_TEXT.pending_station },
  { key: "pending_region", label: STATUS_TEXT.pending_region },
  { key: "signed", label: "已签署" },
  { key: "withdrawn", label: "已撤回" }
];

function chainOf(order: PriceOrder) {
  return store.versionChainOf(order);
}

function signNameKey(order: PriceOrder, role: "station" | "region") {
  return `${role}-${order.id}`;
}

function defaultSignName(order: PriceOrder, role: "station" | "region") {
  const station = stationOf(order.stationCode);
  return role === "station" ? station.manager : station.regionalManager;
}

function stationView(code: StationCode) {
  const station = stationOf(code);
  const used = occupiedBudget(store.orders, code);
  const holders = store.orders.filter((order) => order.stationCode === code && PENDING_STATUSES.includes(order.status));
  return { station, used, remaining: round2(station.budget - used), percent: Math.min(100, Math.round((used / station.budget) * 100)), holders };
}

function resetDemo() {
  if (!window.confirm("恢复演示数据将清空当前全部测算单、预算占用与油价改动，确定继续？")) return;
  store.resetDemo();
  resetForm();
  statusFilter.value = "all";
  stationFilter.value = "all";
}

const currentPriceMismatch = computed(() => {
  if (revision.value) return false;
  const master = store.priceBook[form.stationCode][form.fuel];
  return Number.isFinite(parsed.value.currentPrice) && round2(parsed.value.currentPrice) !== round2(master);
});
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 调价管控双签闭环</p>
          <h1>调价毛利影响双签台</h1>
          <p class="subtitle">
            新建测算单按预计日销量估算调价后首日毛利变化；低于成本保护线或减少额超过油站预算须填写依据，
            经站长、区域经理逐级签署。签署后冻结测算、价格与签名，更正另立版本并保留旧数。
          </p>
        </div>
        <div class="stack">
          <span v-for="item in ['Vue3', 'Pinia', 'TypeScript', '双签留痕', 'localStorage 持久化']" :key="item" class="tag">{{ item }}</span>
          <button type="button" class="secondary" @click="resetDemo">恢复演示数据</button>
        </div>
      </header>

      <section class="metrics">
        <article class="metric">
          <span>待签测算单</span>
          <strong>{{ pendingCount }}</strong>
          <em>站长 / 区域经理逐级签署中</em>
        </article>
        <article class="metric">
          <span>预算预占用 / 日</span>
          <strong>{{ formatMoney(totalHold) }}</strong>
          <em>三站日预算合计 {{ formatMoney(totalBudget) }}</em>
        </article>
        <article class="metric">
          <span>已签署冻结</span>
          <strong>{{ signedCount }}</strong>
          <em>测算、价格、签名不可改</em>
        </article>
        <article class="metric">
          <span>更正版本链</span>
          <strong>{{ chainCount }}</strong>
          <em>旧版本数据完整保留</em>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submitDraft">
          <h2>{{ revision ? `更正测算 · 另立 V${chainOf(revision).length + 1}` : "新建调价测算单" }}</h2>

          <div v-if="revision" class="banner">
            更正模式：基于已签署单 <strong>{{ revision.code }}</strong>（V{{ revision.version }}，
            {{ stationOf(revision.stationCode).name }} / {{ revision.fuel }}）另立版本，旧数保留，仍须站长 → 区域经理双签。
            <button type="button" class="link" @click="resetForm">退出更正</button>
          </div>

          <div class="form-grid">
            <label>
              油站
              <select v-model="form.stationCode" :disabled="!!revision" @change="syncFromMaster">
                <option v-for="station in stations" :key="station.code" :value="station.code">
                  {{ station.name }}（{{ station.region }}）
                </option>
              </select>
            </label>
            <label>
              油品
              <select v-model="form.fuel" :disabled="!!revision" @change="syncFromMaster">
                <option v-for="fuel in fuels" :key="fuel" :value="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              当前价（元/升）
              <input v-model="form.currentPrice" type="number" min="0" step="0.01" required />
              <small v-if="currentPriceMismatch" class="warn-text">
                与油价表现值 {{ store.priceBook[form.stationCode][form.fuel].toFixed(2) }} 不一致，将按手填值作为快照
              </small>
            </label>
            <label>
              目标价（元/升）
              <input v-model="form.targetPrice" type="number" min="0" step="0.01" required />
            </label>
            <label>
              预计日销量（升/日）
              <input v-model="form.dailyVolume" type="number" min="0" step="1" required />
            </label>
            <label>
              单位成本（元/升）
              <input v-model="form.unitCost" type="number" min="0" step="0.01" required />
            </label>
          </div>

          <div v-if="live" class="preview">
            <div class="preview-row">
              <span>单位毛利</span>
              <strong>{{ live.currentUnitProfit.toFixed(2) }} → {{ live.targetUnitProfit.toFixed(2) }} 元/升</strong>
            </div>
            <div class="preview-row">
              <span>首日毛利（按 {{ parsed.dailyVolume.toLocaleString() }} 升估算）</span>
              <strong>{{ formatMoney(live.currentDayProfit) }} → {{ formatMoney(live.targetDayProfit) }}</strong>
            </div>
            <div class="preview-row impact" :class="live.dayProfitChange < 0 ? 'down' : 'up'">
              <span>首日毛利变化</span>
              <strong>{{ formatMoney(live.dayProfitChange) }} / 日</strong>
            </div>
            <div class="preview-row">
              <span>预算预占（减少额）</span>
              <strong>{{ formatMoney(live.budgetHold) }} / 日</strong>
            </div>
            <div class="preview-row">
              <span>{{ formStation.name }}日预算 / 在签已占</span>
              <strong>
                {{ formatMoney(formStation.budget) }} / {{ formatMoney(occupiedBudget(store.orders, form.stationCode)) }}
                <em v-if="liveBudgetGap > 0" class="warn-text">缺口 {{ formatMoney(liveBudgetGap) }}</em>
              </strong>
            </div>
            <ul v-if="liveHits.length" class="hits">
              <li v-for="hit in liveHits" :key="hit.key" class="hit">
                <span class="hit-tag">{{ hit.label }}</span>
                差额 <strong>{{ hit.gap.toFixed(2) }}</strong> {{ hit.key === 'cost_protection' ? '元/升' : '元/日' }} —— {{ hit.detail }}
              </li>
            </ul>
          </div>
          <div v-else class="preview preview-empty">填写全部数值后即时测算首日毛利变化与红线命中情况</div>

          <label class="basis-label">
            调价依据
            <span v-if="basisRequired" class="required">* 命中红线，必须填写依据</span>
          </label>
          <textarea
            v-model="form.basis"
            :placeholder="basisRequired ? '已命中成本保护线或预算红线，请填写调价依据（竞品情况、合同、审批文号等）' : '可选：竞品动态、促销安排、协议编号等'"
          />

          <div v-if="blocker" class="alert-block">
            <p class="alert-title">⛔ 受阻：{{ blocker.condition }}</p>
            <p class="alert-line">油站：<strong>{{ blocker.station }}</strong>　油品：<strong>{{ blocker.fuel }}</strong></p>
            <p v-if="blocker.gap > 0" class="alert-line">
              差额：<strong>{{ blocker.gap.toFixed(2) }}</strong> {{ blocker.gapUnit }}
            </p>
            <p class="alert-message">{{ blocker.message }}</p>
            <div v-if="blocker.existing" class="alert-actions">
              <input v-model="withdrawReason" class="withdraw-input" placeholder="撤回原因" />
              <button type="button" @click="withdrawAndResubmit">撤回前单并释放占位后送签</button>
            </div>
          </div>

          <button class="submit-btn" type="submit">{{ revision ? "另立版本送双签" : "提交测算单送双签" }}</button>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <div class="tabs">
              <button
                v-for="tab in tabs"
                :key="tab.key"
                type="button"
                class="tab"
                :class="{ active: statusFilter === tab.key }"
                @click="statusFilter = tab.key"
              >
                {{ tab.label }}
              </button>
            </div>
            <select v-model="stationFilter" class="station-filter">
              <option value="all">全部油站</option>
              <option v-for="station in stations" :key="station.code" :value="station.code">{{ station.name }}</option>
            </select>
          </div>

          <div class="record-grid">
            <div v-if="filteredOrders.length === 0" class="empty">暂无匹配测算单</div>
            <article v-for="order in filteredOrders" :key="order.id" class="record" :class="`st-${order.status}`">
              <div class="record-head">
                <div>
                  <p class="record-title">{{ stationOf(order.stationCode).name }} · {{ order.fuel }}</p>
                  <p class="record-code">
                    {{ order.code }}
                    <span class="version-chip">V{{ order.version }}</span>
                    <span v-if="order.parentId" class="revise-chip">更正另立</span>
                  </p>
                </div>
                <span class="status" :class="`badge-${order.status}`">{{ STATUS_TEXT[order.status] }}</span>
              </div>

              <div v-if="chainOf(order).length > 1" class="chain">
                版本链：
                <template v-for="(item, idx) in chainOf(order)" :key="item.id">
                  <span class="chain-node" :class="{ current: item.id === order.id, withdrawn: item.status === 'withdrawn' }">
                    V{{ item.version }} · {{ item.code.slice(-4) }}
                  </span>
                  <span v-if="idx < chainOf(order).length - 1"> → </span>
                </template>
              </div>

              <div class="details">
                <span>当前价 → 目标价：<strong>{{ order.currentPrice.toFixed(2) }} → {{ order.targetPrice.toFixed(2) }}</strong> 元/升</span>
                <span>单位成本：<strong>{{ order.unitCost.toFixed(2) }}</strong> 元/升</span>
                <span>预计日销量：<strong>{{ order.dailyVolume.toLocaleString() }}</strong> 升/日</span>
                <span>预算预占：<strong>{{ formatMoney(order.budgetHold) }}</strong> / 日</span>
                <span>单位毛利：<strong>{{ order.currentUnitProfit.toFixed(2) }} → {{ order.targetUnitProfit.toFixed(2) }}</strong></span>
                <span :class="order.dayProfitChange < 0 ? 'text-down' : 'text-up'">
                  首日毛利变化：<strong>{{ formatMoney(order.dayProfitChange) }} / 日</strong>
                </span>
              </div>

              <ul v-if="order.hits.length" class="hits">
                <li v-for="hit in order.hits" :key="hit.key" class="hit">
                  <span class="hit-tag">{{ hit.label }}</span>
                  差额 <strong>{{ hit.gap.toFixed(2) }}</strong> {{ hit.key === 'cost_protection' ? '元/升' : '元/日' }}
                </li>
              </ul>
              <p v-if="order.basis" class="note">依据：{{ order.basis }}</p>

              <div class="sign-block">
                <div class="sign-row" :class="{ done: order.stationSign, locked: order.status === 'signed' }">
                  <span class="sign-role">① 站长签署</span>
                  <template v-if="order.stationSign">
                    <span class="sign-value">✓ {{ order.stationSign.name }} 于 {{ formatDateTime(order.stationSign.signedAt) }}</span>
                  </template>
                  <template v-else-if="order.status === 'pending_station'">
                    <input v-model="signNames[signNameKey(order, 'station')]" :placeholder="defaultSignName(order, 'station')" class="sign-input" />
                    <button type="button" @click="sign(order, 'station')">站长签署</button>
                  </template>
                  <template v-else><span class="sign-value muted">待站长先签</span></template>
                </div>
                <div class="sign-row" :class="{ done: order.regionSign, locked: order.status === 'signed' }">
                  <span class="sign-role">② 区域经理签署</span>
                  <template v-if="order.regionSign">
                    <span class="sign-value">✓ {{ order.regionSign.name }} 于 {{ formatDateTime(order.regionSign.signedAt) }}</span>
                  </template>
                  <template v-else-if="order.status === 'pending_region'">
                    <input v-model="signNames[signNameKey(order, 'region')]" :placeholder="defaultSignName(order, 'region')" class="sign-input" />
                    <button type="button" @click="sign(order, 'region')">区域经理签署</button>
                  </template>
                  <template v-else><span class="sign-value muted">站长签署后开放</span></template>
                </div>
              </div>

              <p v-if="order.status === 'signed'" class="frozen-hint">
                🔒 {{ formatDateTime(order.signedAt) }} 双签完成：测算、价格与签名已冻结，目标价已写入油价表；如需更正请另立版本。
              </p>
              <p v-if="order.status === 'withdrawn'" class="withdrawn-hint">
                已撤回（{{ formatDateTime(order.withdrawnAt) }}）：{{ order.withdrawReason }}，占位与预算预占已释放。
              </p>

              <div class="actions">
                <button v-if="PENDING_STATUSES.includes(order.status)" type="button" class="danger" @click="withdraw(order)">撤回并释放占位</button>
                <button v-if="order.status === 'signed'" type="button" @click="startRevision(order)">更正（另立版本）</button>
                <button v-if="order.status === 'withdrawn'" type="button" class="secondary" @click="reuseWithdrawn(order)">复用数据重新测算</button>
              </div>
            </article>
          </div>
        </section>
      </section>

      <section class="budgets">
        <h2>油站预算与预占</h2>
        <div class="budget-grid">
          <article v-for="view in [stationView('chengdong'), stationView('chengxi'), stationView('chengnan')]" :key="view.station.code" class="budget-card">
            <header>
              <strong>{{ view.station.name }}</strong>
              <span>{{ view.station.region }} · 站长 {{ view.station.manager }} / 区域 {{ view.station.regionalManager }}</span>
            </header>
            <div class="budget-track"><div class="budget-fill" :class="{ over: view.used > view.station.budget }" :style="{ width: `${view.percent}%` }" /></div>
            <p class="budget-line">
              日预算 {{ formatMoney(view.station.budget) }}｜已占 <strong :class="view.used > view.station.budget ? 'text-down' : ''">{{ formatMoney(view.used) }}</strong>｜剩余 {{ formatMoney(view.remaining) }}
            </p>
            <ul v-if="view.holders.length" class="holders">
              <li v-for="holder in view.holders" :key="holder.id">
                {{ holder.code }} · {{ holder.fuel }} · {{ formatMoney(holder.budgetHold) }}/日
                <span class="muted">（{{ STATUS_TEXT[holder.status] }}）</span>
              </li>
            </ul>
            <p v-else class="muted">暂无待签预占</p>
          </article>
        </div>
      </section>

      <section class="pricebook">
        <h2>当前油价表（双签目标价在区域经理签署后写入，重载后保持一致）</h2>
        <table>
          <thead>
            <tr>
              <th>油站</th>
              <th v-for="fuel in fuels" :key="fuel">{{ fuel }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="station in stations" :key="station.code">
              <td>{{ station.name }}</td>
              <td v-for="fuel in fuels" :key="fuel">{{ store.priceBook[station.code][fuel].toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </main>
</template>
