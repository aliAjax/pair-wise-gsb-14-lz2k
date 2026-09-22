<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { evaluateGuard, formatMoney, round2, statusLabel, useDeskStore } from "./store/desk";
import type { Blockage, Sheet } from "./types";

const desk = useDeskStore();
const { state } = desk;

const FILTERS = [
  { key: "ALL", label: "全部单据" },
  { key: "PENDING_STATION", label: "待站长签" },
  { key: "PENDING_REGION", label: "待区域经理签" },
  { key: "SIGNED", label: "双签冻结" },
  { key: "WITHDRAWN", label: "已撤回" }
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const draft = reactive({
  stationCode: "",
  fuelKey: "",
  currentPrice: null as number | null,
  targetPrice: null as number | null,
  dailyVolume: null as number | null,
  unitCost: null as number | null,
  basis: "",
  parentId: null as string | null
});
const filter = ref<FilterKey>("ALL");
const flash = ref("");
const formError = ref("");
const budgetDrafts = reactive<Record<string, string>>({});

function notify(msg: string) {
  flash.value = msg;
}

watch(
  () => [draft.stationCode, draft.fuelKey],
  () => {
    // 切换油站/油品时带出当前价与单位成本；更正模式由 startCorrect 一次性覆盖，不在此清 parent
    if (draft.stationCode && draft.fuelKey) {
      const key = `${draft.stationCode}/${draft.fuelKey}`;
      const price = state.currentPrices[key];
      if (price != null) draft.currentPrice = price;
      draft.unitCost = state.fuels.find((f) => f.key === draft.fuelKey)?.cost ?? null;
    }
  }
);

const draftStation = computed(() =>
  draft.stationCode ? state.stations.find((s) => s.code === draft.stationCode) ?? null : null
);

const parentSheet = computed(() =>
  draft.parentId ? state.sheets.find((s) => s.id === draft.parentId) ?? null : null
);

/** 实时冲突：同油站同油品已有待签单（占位中） */
const liveConflict = computed(() =>
  draft.stationCode && draft.fuelKey
    ? desk.pendingOf(draft.stationCode, draft.fuelKey)
    : null
);

/** 实时毛利测算（按销量估算调价后的首日毛利变化） */
const liveGuard = computed(() => {
  if (
    !draftStation.value ||
    draft.currentPrice == null ||
    draft.targetPrice == null ||
    draft.dailyVolume == null ||
    draft.unitCost == null
  ) {
    return null;
  }
  return evaluateGuard({
    currentPrice: draft.currentPrice,
    targetPrice: draft.targetPrice,
    dailyVolume: draft.dailyVolume,
    unitCost: draft.unitCost,
    protectionMargin: state.protectionMargin,
    budgetTotal: draftStation.value.budget,
    budgetOccupiedOther: desk.occupiedOf(draft.stationCode, undefined)
  });
});

const draftValid = computed(
  () =>
    !!draft.stationCode &&
    !!draft.fuelKey &&
    draft.currentPrice != null &&
    draft.currentPrice >= 0 &&
    draft.targetPrice != null &&
    draft.targetPrice >= 0 &&
    draft.dailyVolume != null &&
    draft.dailyVolume > 0 &&
    draft.unitCost != null &&
    draft.unitCost >= 0
);

const hitsGuard = computed(() => !!liveGuard.value && (liveGuard.value.costHit || liveGuard.value.budgetHit));

function resetDraft() {
  draft.stationCode = "";
  draft.fuelKey = "";
  draft.currentPrice = null;
  draft.targetPrice = null;
  draft.dailyVolume = null;
  draft.unitCost = null;
  draft.basis = "";
  draft.parentId = null;
  formError.value = "";
}

function submit() {
  formError.value = "";
  if (!draftValid.value) {
    formError.value = "请完整填写油站、油品、当前价、目标价、预计日销量和单位成本（日销量须大于0）。";
    return;
  }
  if (liveConflict.value) {
    formError.value =
      `该油站该油品已有待签单 ${liveConflict.value.code}，请先撤回前单释放占位后再提交。`;
    return;
  }
  if (hitsGuard.value && !draft.basis.trim()) {
    formError.value = "已命中成本保护线或超出油站预算，必须填写调价依据。";
    return;
  }
  const result = desk.submitDraft({
    stationCode: draft.stationCode,
    fuelKey: draft.fuelKey,
    currentPrice: draft.currentPrice as number,
    targetPrice: draft.targetPrice as number,
    dailyVolume: draft.dailyVolume as number,
    unitCost: draft.unitCost as number,
    basis: draft.basis,
    parentId: draft.parentId
  });
  if (result.ok && result.sheet) {
    const s = result.sheet;
    notify(
      `测算单 ${s.code} 已创建，状态「${statusLabel(s.status)}」，` +
        `首日毛利变化 ${formatMoney(s.guard.marginChange)}/日。`
    );
    resetDraft();
  } else {
    notify(`提交被阻断，请查看下方「受阻记录」（含油站、油品、差额及命中条件）。`);
  }
}

function startCorrect(sheet: Sheet) {
  filter.value = "ALL";
  draft.parentId = sheet.id;
  draft.stationCode = sheet.stationCode;
  draft.fuelKey = sheet.fuelKey;
  draft.currentPrice = state.currentPrices[`${sheet.stationCode}/${sheet.fuelKey}`] ?? sheet.targetPrice;
  draft.targetPrice = sheet.targetPrice;
  draft.dailyVolume = sheet.dailyVolume;
  draft.unitCost = sheet.unitCost;
  draft.basis = "";
  formError.value = "";
  notify(`正在基于已签单 ${sheet.code}（v${sheet.versionNo}）另立更正版本，旧单数据保留不修改。`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelCorrect() {
  draft.parentId = null;
  draft.basis = "";
  formError.value = "";
  notify("已取消更正，可按新测算单填写。");
}

function doWithdraw(sheet: Sheet) {
  if (desk.withdraw(sheet.id)) {
    notify(`测算单 ${sheet.code} 已撤回，占位与预算占用已释放。`);
  } else {
    notify(`撤回受阻：${sheet.code} 已冻结，只能另立版本更正。`);
  }
}

function doSignStation(sheet: Sheet) {
  if (desk.signStation(sheet.id)) notify(`站长已签署 ${sheet.code}，现待区域经理签署。`);
}

function doSignRegion(sheet: Sheet) {
  if (desk.signRegion(sheet.id))
    notify(`区域经理已签署 ${sheet.code}，双签完成，测算、价格与签名已冻结，当前价已更新。`);
}

function withdrawConflict() {
  if (liveConflict.value) doWithdraw(liveConflict.value);
}

/* -------------------------------- 列表与统计 ------------------------------- */

const filteredSheets = computed(() => {
  const list = filter.value === "ALL" ? state.sheets : state.sheets.filter((s) => s.status === filter.value);
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
});

const countBy = (f: FilterKey) =>
  f === "ALL" ? state.sheets.length : state.sheets.filter((s) => s.status === f).length;

const metrics = computed(() => [
  { label: "测算单总数", value: String(state.sheets.length) },
  { label: "待签占位中", value: String(desk.pendingSheets.length) },
  { label: "双签冻结", value: String(countBy("SIGNED")) },
  { label: "受阻记录", value: String(state.blockages.length) }
]);

function stationName(code: string) {
  return desk.stationMap[code]?.name ?? code;
}
function fuelName(key: string) {
  return desk.fuelMap[key]?.name ?? key;
}
function codeOf(id: string | null) {
  return id ? state.sheets.find((s) => s.id === id)?.code ?? "-" : "-";
}

function chainSheets(sheet: Sheet) {
  return state.sheets
    .filter((s) => s.chainId === sheet.chainId)
    .sort((a, b) => a.versionNo - b.versionNo);
}

function fmtDate(isoStr: string | null) {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* -------------------------------- 当前价矩阵 ------------------------------- */

interface PriceCell {
  price: number | null;
  version: Sheet | null;
}
const priceMatrix = computed(() =>
  state.stations.map((station) => ({
    station,
    cells: state.fuels.map<PriceCell>((fuel) => {
      const price = state.currentPrices[`${station.code}/${fuel.key}`];
      if (price == null) return { price: null, version: null };
      // 当前价来源：已签生效链的最新版本
      const version =
        state.sheets.find(
          (s) =>
            s.stationCode === station.code &&
            s.fuelKey === fuel.key &&
            s.status === "SIGNED" &&
            s.targetPrice === price &&
            desk.effectiveVersionOf(s)?.id === s.id
        ) ?? null;
      return { price, version };
    })
  }))
);

/* -------------------------------- 预算编辑 -------------------------------- */

function saveBudget(code: string) {
  const raw = budgetDrafts[code];
  if (raw == null) return;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0) {
    desk.setBudget(code, v);
    notify(`油站预算已更新为 ${formatMoney(v)}/日。`);
  }
  budgetDrafts[code] = "";
}

function latestBlockage(stationCode: string, fuelKey: string): Blockage | undefined {
  return state.blockages.find((b) => b.stationCode === stationCode && b.fuelKey === fuelKey);
}

const marginTone = (v: number) => (v < 0 ? "neg" : v > 0 ? "pos" : "");
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 调价毛利影响双签台</p>
          <h1>油品调价毛利测算与双签</h1>
          <p class="subtitle">
            新建测算单选择油站、油品、当前价、目标价、预计日销量和单位成本，按销量估算调价后的首日毛利变化；
            击穿成本保护线或减少额超油站预算须填写依据，经站长、区域经理逐级签署；签署后冻结测算、价格与签名，更正另立版本并保留旧数。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
          <span class="tag">localStorage 持久化</span>
        </div>
      </header>

      <p v-if="flash" class="flash">{{ flash }}</p>

      <section class="metrics metrics-4">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <!-- 新建测算单 -->
        <form class="panel" @submit.prevent="submit">
          <h2>新建调价测算单</h2>

          <div v-if="parentSheet" class="correct-banner">
            更正模式：基于 {{ parentSheet.code }}（v{{ parentSheet.versionNo }}，{{ stationName(parentSheet.stationCode) }} / {{ fuelName(parentSheet.fuelKey) }}）另立版本，旧数保留。
            <button type="button" class="link-btn" @click="cancelCorrect">取消更正</button>
          </div>

          <div class="form-grid">
            <label>
              油站
              <select v-model="draft.stationCode" required>
                <option value="">请选择油站</option>
                <option v-for="s in state.stations" :key="s.code" :value="s.code">
                  {{ s.name }}（{{ s.code }}）
                </option>
              </select>
            </label>

            <label>
              油品
              <select v-model="draft.fuelKey" required>
                <option value="">请选择油品</option>
                <option v-for="f in state.fuels" :key="f.key" :value="f.key">{{ f.name }}</option>
              </select>
            </label>

            <label>
              当前价（元/升）
              <input v-model.number="draft.currentPrice" type="number" min="0" step="0.01" required />
            </label>

            <label>
              目标价（元/升）
              <input v-model.number="draft.targetPrice" type="number" min="0" step="0.01" required />
            </label>

            <label>
              预计日销量（升/日）
              <input v-model.number="draft.dailyVolume" type="number" min="0" step="1" required />
            </label>

            <label>
              单位成本（元/升）
              <input v-model.number="draft.unitCost" type="number" min="0" step="0.01" required />
            </label>

            <!-- 实时测算 -->
            <div v-if="liveGuard" class="live-calc">
              <p class="live-title">首日毛利测算（按预计日销量）</p>
              <div class="live-row"><span>当前价首日毛利</span><strong>{{ formatMoney(liveGuard.currentDayMargin) }}</strong></div>
              <div class="live-row"><span>目标价首日毛利</span><strong>{{ formatMoney(liveGuard.targetDayMargin) }}</strong></div>
              <div class="live-row">
                <span>首日毛利变化</span>
                <strong :class="marginTone(liveGuard.marginChange)">
                  {{ liveGuard.marginChange > 0 ? "+" : "" }}{{ formatMoney(liveGuard.marginChange) }} / 日
                </strong>
              </div>
              <div class="live-row">
                <span>毛利减少额</span>
                <strong :class="liveGuard.reduction > 0 ? 'neg' : ''">{{ formatMoney(liveGuard.reduction) }} / 日</strong>
              </div>
            </div>

            <!-- 预算占用 -->
            <div v-if="draftStation" class="budget-hint">
              <p>
                {{ draftStation.name }} 日预算 {{ formatMoney(draftStation.budget) }}，
                其他待签单已占 {{ formatMoney(desk.budgetOccupied[draftStation.code] ?? 0) }}，
                剩余 {{ formatMoney(Math.max(0, draftStation.budget - (desk.budgetOccupied[draftStation.code] ?? 0))) }}/日
              </p>
            </div>

            <!-- 守卫命中提示 -->
            <div v-if="liveGuard" class="guards">
              <div class="guard" :class="liveGuard.costHit ? 'hit' : 'ok'">
                <strong>成本保护线 {{ liveGuard.linePrice.toFixed(2) }} 元/升</strong>
                <span v-if="liveGuard.costHit">
                  击穿！目标价低 {{ liveGuard.costGap.toFixed(2) }} 元/升，必须填写依据
                </span>
                <span v-else>目标价在线上，安全</span>
              </div>
              <div class="guard" :class="liveGuard.budgetHit ? 'hit' : 'ok'">
                <strong>油站让利预算 {{ formatMoney(liveGuard.budgetTotal) }}/日</strong>
                <span v-if="liveGuard.budgetHit">
                  超预算 {{ formatMoney(liveGuard.budgetGap) }}/日（剩余 {{ formatMoney(liveGuard.budgetAvailable) }}），必须填写依据
                </span>
                <span v-else>减少额在剩余预算内</span>
              </div>
            </div>

            <!-- 占位冲突 -->
            <div v-if="liveConflict" class="conflict">
              <p>
                已有待签单 {{ liveConflict.code }}（{{ statusLabel(liveConflict.status) }}）占位，
                占用预算 {{ formatMoney(liveConflict.guard.reduction) }}/日。
                同一油站同一油品只能保留一张待签单。
              </p>
              <button type="button" class="danger" @click="withdrawConflict">撤回前单并释放占位</button>
            </div>

            <label>
              调价依据
              <textarea
                v-model="draft.basis"
                :class="{ required: hitsGuard }"
                :placeholder="hitsGuard
                  ? '已命中成本保护线/超预算，依据为必填项'
                  : '说明调价原因；未命中守卫时可留空'"
              />
            </label>

            <p v-if="formError" class="form-error">{{ formError }}</p>

            <button type="submit" :disabled="!!liveConflict">提交测算单进入双签</button>
          </div>
        </form>

        <!-- 测算单列表 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>测算单列表</h2>
            <div class="filters">
              <button
                v-for="f in FILTERS"
                :key="f.key"
                type="button"
                class="chip"
                :class="{ active: filter === f.key }"
                @click="filter = f.key"
              >
                {{ f.label }} {{ countBy(f.key) }}
              </button>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filteredSheets.length === 0" class="empty">暂无匹配单据</div>

            <article
              v-for="record in filteredSheets"
              :key="record.id"
              class="record"
              :class="{ frozen: record.status === 'SIGNED', withdrawn: record.status === 'WITHDRAWN' }"
            >
              <div class="record-head">
                <p class="record-title">
                  {{ stationName(record.stationCode) }} / {{ fuelName(record.fuelKey) }}
                  <span class="code">{{ record.code }}</span>
                </p>
                <span class="status" :class="record.status.toLowerCase()">
                  {{ statusLabel(record.status) }}
                </span>
              </div>

              <div class="details">
                <span>当前价：{{ record.currentPrice.toFixed(2) }} 元/升</span>
                <span>目标价：<strong>{{ record.targetPrice.toFixed(2) }} 元/升</strong></span>
                <span>预计日销量：{{ record.dailyVolume.toLocaleString() }} 升</span>
                <span>单位成本：{{ record.unitCost.toFixed(2) }} 元/升</span>
                <span>首日毛利变化：<b :class="marginTone(record.guard.marginChange)">{{ formatMoney(record.guard.marginChange) }}/日</b></span>
                <span>成本保护线：{{ record.guard.linePrice.toFixed(2) }} 元/升</span>
              </div>

              <div class="guard-tags">
                <span class="g-tag" :class="record.guard.costHit ? 'hit' : 'ok'">
                  保护线{{ record.guard.costHit ? `击穿 -${record.guard.costGap.toFixed(2)}元/升` : "未击穿" }}
                </span>
                <span class="g-tag" :class="record.guard.budgetHit ? 'hit' : 'ok'">
                  预算{{ record.guard.budgetHit ? `超出 ${formatMoney(record.guard.budgetGap)}/日` : `占用 ${formatMoney(record.guard.reduction)}/日` }}
                </span>
                <span class="ver-tag">
                  v{{ record.versionNo }}
                  <template v-if="record.parentId">（更正自 {{ codeOf(record.parentId) }}）</template>
                  <template v-else>（首版）</template>
                </span>
                <span v-if="record.status === 'SIGNED' && desk.isSuperseded(record)" class="ver-tag old">旧版本 · 已被更正</span>
              </div>

              <p class="note">依据：{{ record.basis || "（未命中守卫，无需依据）" }}</p>

              <div class="signs">
                <div class="sign" :class="{ done: record.stationSign }">
                  <span class="sign-role">站长签</span>
                  <template v-if="record.stationSign">
                    <b>{{ record.stationSign.name }}</b>
                    <time>{{ fmtDate(record.stationSign.at) }}</time>
                  </template>
                  <em v-else>待签</em>
                </div>
                <div class="sign-arrow">→</div>
                <div class="sign" :class="{ done: record.regionSign }">
                  <span class="sign-role">区域经理签</span>
                  <template v-if="record.regionSign">
                    <b>{{ record.regionSign.name }}</b>
                    <time>{{ fmtDate(record.regionSign.at) }}</time>
                  </template>
                  <em v-else>待签</em>
                </div>
                <span v-if="record.frozenAt" class="frozen-at">冻结于 {{ fmtDate(record.frozenAt) }}</span>
              </div>

              <!-- 版本链 -->
              <details class="chain">
                <summary>版本链（{{ chainSheets(record).length }}）</summary>
                <ul>
                  <li v-for="v in chainSheets(record)" :key="v.id" :class="{ current: v.id === record.id }">
                    {{ v.code }} · v{{ v.versionNo }} · {{ statusLabel(v.status) }} ·
                    目标价 {{ v.targetPrice.toFixed(2) }} · 毛利变化 {{ formatMoney(v.guard.marginChange) }}/日
                  </li>
                </ul>
              </details>

              <div class="actions">
                <button v-if="record.status === 'PENDING_STATION'" type="button" @click="doSignStation(record)">
                  站长签署
                </button>
                <button v-if="record.status === 'PENDING_REGION'" type="button" @click="doSignRegion(record)">
                  区域经理签署
                </button>
                <button
                  v-if="record.status === 'PENDING_STATION' || record.status === 'PENDING_REGION'"
                  class="secondary"
                  type="button"
                  @click="doWithdraw(record)"
                >
                  撤回并释放占位
                </button>
                <button
                  v-if="record.status === 'SIGNED' && desk.effectiveVersionOf(record)?.id === record.id"
                  class="secondary"
                  type="button"
                  @click="startCorrect(record)"
                >
                  更正（另立版本）
                </button>
                <span v-if="record.status === 'SIGNED'" class="frozen-note">已冻结，测算/价格/签名不可改</span>
                <span v-if="record.status === 'WITHDRAWN'" class="frozen-note">占位与预算已释放</span>
              </div>
            </article>
          </div>
        </section>
      </section>

      <!-- 底部：预算 / 受阻记录 -->
      <section class="bottom-grid">
        <section class="panel">
          <h2>油站预算与成本保护线</h2>
          <label class="protection">
            成本保护加价（元/升）：保护线 = 单位成本 +
            <input
              :value="state.protectionMargin"
              type="number"
              min="0"
              step="0.01"
              @change="desk.setProtectionMargin(Number(($event.target as HTMLInputElement).value))"
            />
            <small>当前 {{ state.protectionMargin.toFixed(2) }} 元/升</small>
          </label>
          <div v-for="s in state.stations" :key="s.code" class="budget-row">
            <div class="budget-head">
              <strong>{{ s.name }}</strong>
              <span :class="(desk.budgetOccupied[s.code] ?? 0) > s.budget ? 'neg' : ''">
                已占 {{ formatMoney(desk.budgetOccupied[s.code] ?? 0) }} / {{ formatMoney(s.budget) }}/日
              </span>
            </div>
            <div class="bar-track">
              <div
                class="bar-fill"
                :class="{ over: (desk.budgetOccupied[s.code] ?? 0) > s.budget }"
                :style="{ width: `${Math.min(100, ((desk.budgetOccupied[s.code] ?? 0) / Math.max(s.budget, 1)) * 100)}%` }"
              />
            </div>
            <div class="budget-edit">
              <input v-model="budgetDrafts[s.code]" type="number" min="0" step="50" placeholder="调整日预算" />
              <button type="button" class="secondary" @click="saveBudget(s.code)">保存预算</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="toolbar">
            <h2>受阻记录</h2>
            <button type="button" class="secondary" @click="desk.clearBlockages()">清空</button>
          </div>
          <div v-if="state.blockages.length === 0" class="empty">暂无受阻记录</div>
          <ul class="blockage-list">
            <li v-for="b in state.blockages" :key="b.id" class="blockage">
              <div class="blockage-head">
                <strong>{{ b.action }}受阻</strong>
                <time>{{ fmtDate(b.at) }}</time>
              </div>
              <p class="blockage-key">{{ b.stationName }} / {{ b.fuelName }}</p>
              <p class="blockage-cond">命中条件：{{ b.condition }}</p>
              <p v-if="b.gap != null" class="blockage-gap">
                差额：{{ b.gapUnit.includes("元/升") ? `${b.gap.toFixed(2)} 元/升` : `${formatMoney(b.gap)}/日` }}
                （{{ b.gapUnit }}）
              </p>
              <p class="blockage-detail">{{ b.detail }}</p>
            </li>
          </ul>
        </section>
      </section>

      <!-- 当前价矩阵 -->
      <section class="panel prices">
        <div class="toolbar">
          <h2>当前挂牌价（双签后按目标价更新，重载后保持对应）</h2>
          <button type="button" class="secondary" @click="desk.resetDemo(); notify('已恢复演示数据。')">
            恢复演示数据
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>油站 / 油品</th>
              <th v-for="f in state.fuels" :key="f.key">{{ f.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in priceMatrix" :key="row.station.code">
              <td>{{ row.station.name }}<small>{{ row.station.code }}</small></td>
              <td v-for="(cell, i) in row.cells" :key="state.fuels[i].key">
                <template v-if="cell.price != null">
                  <strong>{{ cell.price.toFixed(2) }}</strong>
                  <small v-if="cell.version" class="src">
                    来源 {{ cell.version.code }} v{{ cell.version.versionNo }}
                  </small>
                </template>
                <span v-else class="muted">未维护</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </main>
</template>
