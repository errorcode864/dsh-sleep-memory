/**
 * dsh-sleep-memory — Web client half (v1.0, M9).
 *
 * One surface: the「记忆银行」main panel plus its sidebar entry. It talks to the
 * plugin's own Host half through the typert Remote bridge (`sleepMemoryApi`):
 *
 * - `stats()` — layer counts, superseded count, edge count, oldest/newest.
 * - `list({layer, query, limit, offset})` — paginated live-record browse.
 * - `edges()` — every dream-associate/consolidates edge for the edge view.
 * - `runSleep({dryRun})` — trigger a sleep cycle and show the four-phase report.
 *
 * The panel is read-mostly; the single write (`runSleep`) runs a real cycle
 * only from its explicit button, and a separate button runs the dry-run
 * preview that reports what would change without persisting anything.
 *
 * Layout: sidebar entry `sidebar.panellist` (id `sleep-memory`, order 27,
 * locale thunk label) and main panel `main` keyed `sleep-memory`.
 *
 * Views share one toolbar (search + layer filter): 记录 browse list, the
 * salient valence×arousal scatter, and the association-edge list. Colors come
 * only from registered `--dsw-*` aliases; strings resolve through the
 * `sleep-memory` locale namespace.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sleep-memory',
  factory(require) {
    const React = require('react');
    const { useState, useMemo, useCallback, useEffect, useRef, useSyncExternalStore } = React;
    const h = React.createElement;

    const PACKAGE_ID = 'dsh-sleep-memory';
    const SLOT_ID = 'sleep-memory';
    const NS = 'sleep-memory';

    const REMOTE_SERVICE = 'sleepMemoryApi';
    const REMOTE_NAMESPACE = 'sleepMemoryApi';
    const NOARG_METHODS = new Set(['stats', 'edges', 'getConfig']);
    const REMOTE_METHODS = ['stats', 'list', 'edges', 'runSleep', 'getConfig', 'setConfig'];
    const INPUT_CODEC = Object.freeze({
      mode: 'strict',
      typeSymbol: Symbol('sleepMemoryApi.input'),
      create: () => ({}),
    });
    const DESCRIPTORS = REMOTE_METHODS.map((method) => ({
      id: `${PACKAGE_ID}#${REMOTE_NAMESPACE}/${method}`,
      service: REMOTE_SERVICE,
      namespace: REMOTE_NAMESPACE,
      method,
      parameters: NOARG_METHODS.has(method)
        ? []
        : [{ name: 'input', wire: 'input', source: 'json', codec: INPUT_CODEC }],
      result: { mode: 'src-json' },
      invocation: { kind: 'direct' },
    }));

    const LAYERS = ['surface', 'deep', 'archive', 'salient'];
    const PAGE_SIZE = 50;

    // ---- locale dictionaries -------------------------------------------------

    const ZH = {
      'sleep-memory.panel': '记忆银行',
      'sleep-memory.page.title': '记忆银行',

      'sleep-memory.stats.title': '库概况',
      'sleep-memory.stats.total': '{n} 条活记录',
      'sleep-memory.stats.superseded': '{n} 条已被合并',
      'sleep-memory.stats.edges': '{n} 条联想边',
      'sleep-memory.stats.span': '{from} ~ {to}',
      'sleep-memory.stats.spanSingle': '{at}',
      'sleep-memory.stats.spanNone': '暂无记录',
      'sleep-memory.stats.refresh': '刷新',

      'sleep-memory.browse.title': '记忆浏览',
      'sleep-memory.browse.count': '共 {n} 条',
      'sleep-memory.browse.more': '加载更多',
      'sleep-memory.browse.loadingMore': '加载中…',

      'sleep-memory.search': '搜索记忆内容、标签、关键词',
      'sleep-memory.search.aria': '搜索记忆',
      'sleep-memory.filter.label': '记忆层',
      'sleep-memory.filter.all': '全部层',
      'sleep-memory.layer.surface': '表层',
      'sleep-memory.layer.deep': '深层',
      'sleep-memory.layer.archive': '归档',
      'sleep-memory.layer.salient': '显著',
      'sleep-memory.kind.fact': '事实',
      'sleep-memory.kind.experience': '经历',

      'sleep-memory.row.importance': '重要度',
      'sleep-memory.row.strength': '强度',
      'sleep-memory.row.access': '访问 {n} 次',
      'sleep-memory.row.emotion': '情绪 {v} / {a}',
      'sleep-memory.row.edgeCount': '{n} 条边',

      'sleep-memory.scatter.title': '显著情绪空间',
      'sleep-memory.scatter.count': '{n} 条显著记忆',
      'sleep-memory.scatter.hint': '横轴效价（负 ← → 正），纵轴唤醒（上高下低）',
      'sleep-memory.scatter.empty': '暂无显著情绪记忆',
      'sleep-memory.scatter.axis.valence': '效价',
      'sleep-memory.scatter.axis.arousal': '唤醒',

      'sleep-memory.edges.title': '联想网络',
      'sleep-memory.edges.count': '{n} 条边',
      'sleep-memory.edges.relation.dream-associate': '梦境联想',
      'sleep-memory.edges.relation.consolidates': '巩固沉淀',
      'sleep-memory.edges.empty': '暂无联想边（睡眠整理后产生）',

      'sleep-memory.sleep.run': '立即睡眠',
      'sleep-memory.sleep.runAria': '立即执行一次睡眠整理',
      'sleep-memory.sleep.dryRun': '预演',
      'sleep-memory.sleep.dryRunAria': '预演一次睡眠整理，不落库',
      'sleep-memory.sleep.running': '睡眠中…',
      'sleep-memory.sleep.previewing': '预演中…',
      'sleep-memory.sleep.done': '睡眠整理完成',
      'sleep-memory.sleep.previewDone': '预演完成（未落库）',
      'sleep-memory.sleep.phase.consolidate': 'NREM 巩固 {n}',
      'sleep-memory.sleep.phase.archive': '归档降级 {n}',
      'sleep-memory.sleep.phase.forget': '遗忘清除 {n}',
      'sleep-memory.sleep.phase.rem': 'REM 联想边 +{n}',
      'sleep-memory.sleep.phase.decay': '强度衰减 {n}',
      'sleep-memory.sleep.records': '记录 {before} → {after}',
      'sleep-memory.sleep.capacityLimited': '容量上限截断生效',
      'sleep-memory.sleep.failed': '睡眠整理失败，请重试',
      'sleep-memory.sleep.dismiss': '关闭',

      'sleep-memory.empty.title': '记忆银行还是空的',
      'sleep-memory.empty.hint': '与助手对话时它会自动写入记忆，也可以让它用 memory_write 工具记录',
      'sleep-memory.empty.filtered.title': '没有匹配的记忆',
      'sleep-memory.empty.filtered.action': '清空筛选',
      'sleep-memory.state.loading': '正在加载…',
      'sleep-memory.toast.failed': '加载失败，请重试',

      'sleep-memory.config.summary': '在插件详情页内联调整记忆库运行参数，保存后经宿主配置覆盖层即时生效。',
      'sleep-memory.config.loading': '配置加载中…',
      'sleep-memory.config.loadFailed': '加载失败，请重试',
      'sleep-memory.config.save': '保存',
      'sleep-memory.config.saving': '保存中…',
      'sleep-memory.config.saved': '已保存并生效',
      'sleep-memory.config.saveFailed': '保存失败',
      'sleep-memory.config.reset': '恢复默认',
      'sleep-memory.config.field.injectEnabled': '自动注入',
      'sleep-memory.config.field.injectEnabled.hint': '每轮对话前自动注入相关记忆',
      'sleep-memory.config.field.recallBudget': '召回条数',
      'sleep-memory.config.field.recallBudget.hint': '每次召回返回的记忆条数（1–50）',
      'sleep-memory.config.field.injectBudget': '注入条数',
      'sleep-memory.config.field.injectBudget.hint': '自动注入的最大条数（0–10，0 为关闭）',
      'sleep-memory.config.field.sleepIntervalMinutes': '睡眠间隔',
      'sleep-memory.config.field.sleepIntervalMinutes.hint': '自动睡眠整理周期（分钟，0–10080，0 为关闭）',
    };

    const EN = {
      'sleep-memory.panel': 'Memory bank',
      'sleep-memory.page.title': 'Memory bank',

      'sleep-memory.stats.title': 'Bank overview',
      'sleep-memory.stats.total': '{n} live records',
      'sleep-memory.stats.superseded': '{n} consolidated away',
      'sleep-memory.stats.edges': '{n} association edges',
      'sleep-memory.stats.span': '{from} ~ {to}',
      'sleep-memory.stats.spanSingle': '{at}',
      'sleep-memory.stats.spanNone': 'No records yet',
      'sleep-memory.stats.refresh': 'Refresh',

      'sleep-memory.browse.title': 'Browse memories',
      'sleep-memory.browse.count': '{n} total',
      'sleep-memory.browse.more': 'Load more',
      'sleep-memory.browse.loadingMore': 'Loading…',

      'sleep-memory.search': 'Search memory content, tags, keywords',
      'sleep-memory.search.aria': 'Search memories',
      'sleep-memory.filter.label': 'Layer',
      'sleep-memory.filter.all': 'All layers',
      'sleep-memory.layer.surface': 'Surface',
      'sleep-memory.layer.deep': 'Deep',
      'sleep-memory.layer.archive': 'Archive',
      'sleep-memory.layer.salient': 'Salient',
      'sleep-memory.kind.fact': 'fact',
      'sleep-memory.kind.experience': 'experience',

      'sleep-memory.row.importance': 'importance',
      'sleep-memory.row.strength': 'strength',
      'sleep-memory.row.access': '{n} accesses',
      'sleep-memory.row.emotion': 'emotion {v} / {a}',
      'sleep-memory.row.edgeCount': '{n} edges',

      'sleep-memory.scatter.title': 'Salient emotion space',
      'sleep-memory.scatter.count': '{n} salient memories',
      'sleep-memory.scatter.hint': 'X: valence (negative ← → positive); Y: arousal (high at top)',
      'sleep-memory.scatter.empty': 'No salient emotional memories yet',
      'sleep-memory.scatter.axis.valence': 'valence',
      'sleep-memory.scatter.axis.arousal': 'arousal',

      'sleep-memory.edges.title': 'Association network',
      'sleep-memory.edges.count': '{n} edges',
      'sleep-memory.edges.relation.dream-associate': 'dream associate',
      'sleep-memory.edges.relation.consolidates': 'consolidates',
      'sleep-memory.edges.empty': 'No edges yet (produced by sleep cycles)',

      'sleep-memory.sleep.run': 'Sleep now',
      'sleep-memory.sleep.runAria': 'Run one sleep cycle now',
      'sleep-memory.sleep.dryRun': 'Preview',
      'sleep-memory.sleep.dryRunAria': 'Preview one sleep cycle without persisting',
      'sleep-memory.sleep.running': 'Sleeping…',
      'sleep-memory.sleep.previewing': 'Previewing…',
      'sleep-memory.sleep.done': 'Sleep cycle complete',
      'sleep-memory.sleep.previewDone': 'Preview complete (nothing persisted)',
      'sleep-memory.sleep.phase.consolidate': 'NREM consolidate {n}',
      'sleep-memory.sleep.phase.archive': 'Archive demotion {n}',
      'sleep-memory.sleep.phase.forget': 'Forget purge {n}',
      'sleep-memory.sleep.phase.rem': 'REM edges +{n}',
      'sleep-memory.sleep.phase.decay': 'Decayed {n}',
      'sleep-memory.sleep.records': 'Records {before} → {after}',
      'sleep-memory.sleep.capacityLimited': 'Capacity limit truncation applied',
      'sleep-memory.sleep.failed': 'Sleep cycle failed, please retry',
      'sleep-memory.sleep.dismiss': 'Dismiss',

      'sleep-memory.empty.title': 'The memory bank is empty',
      'sleep-memory.empty.hint': 'The assistant writes memories as you talk; you can also ask it to use the memory_write tool',
      'sleep-memory.empty.filtered.title': 'No memories match',
      'sleep-memory.empty.filtered.action': 'Clear filters',
      'sleep-memory.state.loading': 'Loading…',
      'sleep-memory.toast.failed': 'Loading failed, please retry',

      'sleep-memory.config.summary': 'Tune memory-bank run-time settings inline on the plugin detail page; changes persist through the host configuration overlay and take effect immediately.',
      'sleep-memory.config.loading': 'Loading settings…',
      'sleep-memory.config.loadFailed': 'Loading failed, please retry',
      'sleep-memory.config.save': 'Save',
      'sleep-memory.config.saving': 'Saving…',
      'sleep-memory.config.saved': 'Saved and applied',
      'sleep-memory.config.saveFailed': 'Save failed',
      'sleep-memory.config.reset': 'Reset',
      'sleep-memory.config.field.injectEnabled': 'Auto-inject',
      'sleep-memory.config.field.injectEnabled.hint': 'Inject relevant memories before each turn',
      'sleep-memory.config.field.recallBudget': 'Recall budget',
      'sleep-memory.config.field.recallBudget.hint': 'Memories returned per recall (1–50)',
      'sleep-memory.config.field.injectBudget': 'Injection budget',
      'sleep-memory.config.field.injectBudget.hint': 'Max memories auto-injected per turn (0–10, 0 disables)',
      'sleep-memory.config.field.sleepIntervalMinutes': 'Sleep interval',
      'sleep-memory.config.field.sleepIntervalMinutes.hint': 'Automatic sleep cycle in minutes (0–10080, 0 disables)',
    };

    // ---- style --------------------------------------------------------------

    const STYLE_ID = 'sleep-memory-style';
    const STYLE = `
.sm-page { height: 100%; min-height: 0; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 24px 32px 40px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
.sm-page *, .sm-page *::before, .sm-page *::after { box-sizing: border-box; }
.sm-inner { width: 100%; max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.sm-head { display: flex; flex-direction: column; gap: 2px; padding-bottom: 4px; }
.sm-title { margin: 0; font-size: 21px; line-height: 30px; font-weight: 700; }

.sm-card { display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); overflow: hidden; }
.sm-statrow { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 16px; }
.sm-statrow + .sm-statrow { border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-stat { display: flex; flex-direction: column; gap: 1px; min-width: 72px; }
.sm-statnum { font-size: 18px; line-height: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sm-statlabel { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.sm-layers { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sm-spanshot { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.sm-spring { flex: 1 1 auto; }

.sm-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-toolbar-grow { flex: 1 1 220px; min-width: 160px; }
.sm-search { width: 100%; height: 32px; padding: 0 10px; font: inherit; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); outline: none; }
.sm-search::placeholder { color: var(--dsw-alias-label-secondary); }
.sm-search:focus-visible { border-color: var(--dsw-alias-brand-primary); }
.sm-select { height: 32px; padding: 0 8px; max-width: 160px; font: inherit; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); }
.sm-select:disabled { color: var(--dsw-alias-label-secondary); opacity: 0.7; }
.sm-select:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.sm-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: none; }

.sm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; font: inherit; font-size: 13px; line-height: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.sm-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.sm-btn:disabled { opacity: 0.55; cursor: default; }
.sm-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.sm-btn-outline { background: none; color: var(--dsw-alias-label-secondary); }
.sm-btn-outline:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.sm-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.sm-btn-primary:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 85%, var(--dsw-alias-bg-base)); }

.sm-listhead { display: flex; align-items: center; gap: 8px; padding: 6px 0 0; }
.sm-listtitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.sm-badge { flex: none; padding: 0 6px; border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; font-weight: 500; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l2); }
.sm-badge.is-layer { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
.sm-badge.is-salient-pos { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent); }
.sm-badge.is-salient-neg { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }
.sm-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.sm-tabs { display: flex; align-items: center; gap: 2px; padding: 2px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }
.sm-tab { appearance: none; border: none; height: 26px; padding: 0 12px; font: inherit; font-size: 12px; line-height: 16px; border-radius: calc(var(--dsw-radius-sm) - 2px); background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.sm-tab:hover { color: var(--dsw-alias-label-primary); }
.sm-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; }
.sm-tab:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -1px; }

.sm-rows { display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); overflow: hidden; }
.sm-row { display: flex; flex-direction: column; gap: 5px; padding: 10px 14px; }
.sm-row + .sm-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-rowhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-rowmeta { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.sm-rowcontent { min-width: 0; font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sm-rowtags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sm-tag { padding: 0 6px; border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.sm-bars { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sm-bar { display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.sm-barlabel { flex: none; }
.sm-bartrack { position: relative; width: 72px; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.sm-barfill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--dsw-alias-brand-primary); }

.sm-scatterwrap { display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 14px; }
.sm-scatter { width: 100%; height: auto; display: block; }
.sm-scatteraxis { font-size: 11px; fill: var(--dsw-alias-label-secondary); }
.sm-scattergrid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
.sm-scatterdot.is-pos { fill: var(--dsw-alias-state-success-primary); }
.sm-scatterdot.is-neg { fill: var(--dsw-alias-state-error-primary); }
.sm-scatterdot:hover { stroke: var(--dsw-alias-label-primary); stroke-width: 1.5; }
.sm-scatterhint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }

.sm-edgegroup { display: flex; flex-direction: column; gap: 0; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); overflow: hidden; }
.sm-edgerow { display: flex; align-items: center; gap: 10px; padding: 8px 14px; }
.sm-edgerow + .sm-edgerow { border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-edgearrow { flex: none; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; }
.sm-edgeend { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }
.sm-edgeweight { flex: none; width: 72px; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); position: relative; overflow: hidden; }
.sm-edgeweightfill { position: absolute; inset: 0 auto 0 0; background: var(--dsw-alias-brand-primary); border-radius: 3px; }

.sm-banner { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid var(--dsw-alias-state-success-primary); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.sm-bannertext { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.sm-bannertitle { font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sm-bannerphases { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 44px 16px; text-align: center; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.sm-empty-title { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.sm-skel { display: flex; align-items: center; gap: 12px; height: 52px; padding: 0 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); }
.sm-skbar { height: 12px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-2); }

.sm-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 300; display: flex; align-items: center; gap: 10px; max-width: min(560px, calc(100vw - 48px)); padding: 8px 14px; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); box-shadow: var(--dsw-shadow-lv2); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.sm-toastdot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.sm-toast.is-error .sm-toastdot { background: var(--dsw-alias-state-error-primary); }

/* Plugin-manager row config slot (plugins.row.config). */
.sm-config { display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); overflow: hidden; }
.sm-config-row { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 10px 16px; }
.sm-config-row + .sm-config-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-config-label { min-width: 128px; font-weight: 500; }
.sm-config-check { width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.sm-config-num { flex: none; width: 96px; }
.sm-config-hint { flex: 1 1 220px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.sm-config-reset { height: 24px; padding: 0 10px; font-size: 12px; line-height: 22px; }
.sm-config-note { padding: 10px 16px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.sm-config-error { padding: 8px 16px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }

@media (prefers-reduced-motion: no-preference) {
  .sm-btn, .sm-tab { transition-duration: var(--ds-transition-duration-fast, 0.12s); }
}
`;

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      // Always replace: a style tag left by an earlier instance would pin stale CSS.
      const previous = document.getElementById(STYLE_ID);
      if (previous) {
        try { previous.remove(); } catch { /* already detached */ }
      }
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = STYLE;
      (document.head ?? document.documentElement).appendChild(el);
    }

    // ---- helpers ------------------------------------------------------------

    function clamp01(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.min(1, Math.max(0, n));
    }

    /** Relative age of a timestamp; a missing/invalid stamp renders nothing. */
    function relTime(ts) {
      const value = Number(ts);
      if (!Number.isFinite(value) || value <= 0) return '';
      const diff = Date.now() - value;
      const minute = 60_000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (diff < minute) return '<1 min';
      if (diff < hour) return `${Math.floor(diff / minute)} min`;
      if (diff < day) return `${Math.floor(diff / hour)} h`;
      if (diff < 7 * day) return `${Math.floor(diff / day)} d`;
      return new Date(value).toLocaleDateString();
    }

    function shortDate(ts) {
      const value = Number(ts);
      if (!Number.isFinite(value) || value <= 0) return '';
      return new Date(value).toLocaleDateString();
    }

    function valenceText(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '0';
      return n.toFixed(2);
    }

    // ---- icons --------------------------------------------------------------

    function MemoryIcon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
      h('circle', { cx: 12, cy: 12, r: 8 }),
      h('circle', { cx: 12, cy: 12, r: 3 }),
      h('path', { d: 'M12 4v5M12 15v5M4 12h5M15 12h5' }));
    }

    function MoonIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
      h('path', { d: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z' }));
    }

    function LinkIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
      h('path', { d: 'M9.5 14.5l5-5' }),
      h('path', { d: 'M7 12l-2.2 2.2a3.5 3.5 0 0 0 5 5L12 17' }),
      h('path', { d: 'M17 12l2.2-2.2a3.5 3.5 0 0 0-5-5L12 7' }));
    }

    /** Sidebar occupant: the memory glyph; `active` follows the selected panel. */
    function MemorySidebarIcon({ size, active }) {
      return h('span', {
        style: { display: 'inline-flex', color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
      }, h(MemoryIcon, { size: size ?? 18 }));
    }

    // ---- plugin apply -------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyle();

        const t = ctx.locale.bind(NS);
        let localeTick = 0;
        const localeListeners = new Set();
        const notifyLocale = () => {
          localeTick += 1;
          for (const fn of [...localeListeners]) { try { fn(); } catch { /* listener gone */ } }
        };
        const unsubscribeLocale = ctx.locale.subscribe(notifyLocale);
        /** Re-render on locale change so every visible string follows the switch. */
        const useLocale = () => useSyncExternalStore(
          (onStoreChange) => { localeListeners.add(onStoreChange); return () => localeListeners.delete(onStoreChange); },
          () => localeTick,
        );

        // Toast: a single slot, 4.5s, role="status"; errors get the error dot.
        let toastSeq = 0;
        const toastState = { current: null };
        const toastListeners = new Set();
        const notifyToast = () => { for (const fn of [...toastListeners]) { try { fn(); } catch { /* listener gone */ } } };
        let toastTimer = null;
        function showToast(text, isError) {
          toastSeq += 1;
          toastState.current = { seq: toastSeq, text, isError: isError === true };
          if (toastTimer) clearTimeout(toastTimer);
          toastTimer = setTimeout(() => { toastState.current = null; notifyToast(); }, 4500);
          notifyToast();
        }
        function useToast() {
          return useSyncExternalStore(
            (onStoreChange) => { toastListeners.add(onStoreChange); return () => toastListeners.delete(onStoreChange); },
            () => toastState.current,
            () => null,
          );
        }

        // ---- Remote bridge (this plugin's own Host service) -----------------

        let bridge = null;
        let bridgeState = { status: 'idle', error: null };
        let mounting = null;

        /** Mount once; concurrent callers await the same in-flight mount instead of observing the transient `mounting` state. */
        async function mountBridge() {
          if (bridgeState.status === 'ready') return;
          if (bridgeState.status === 'mounting' && mounting !== null) return mounting;
          bridgeState = { status: 'mounting', error: null };
          mounting = (async () => {
            try {
              const remote = ctx.get('remote');
              if (!remote || typeof remote.$mount !== 'function') throw new Error('remote gateway unavailable');
              const disposer = await remote.$mount({ package: PACKAGE_ID, descriptors: DESCRIPTORS });
              const ns = ctx.get(`remote.${REMOTE_NAMESPACE}`);
              if (!ns) throw new Error('remote namespace not installed');
              bridge = { disposer, ns };
              bridgeState = { status: 'ready', error: null };
            } catch (error) {
              bridge = null;
              bridgeState = { status: 'failed', error };
              console.error('[sleep-memory] bridge mount failed:', error);
            } finally {
              mounting = null;
            }
          })();
          return mounting;
        }

        /** Invoke one Host method and unwrap `{ok, value|error}`; throws on failure. */
        async function call(method, input) {
          if (bridgeState.status !== 'ready') await mountBridge();
          if (bridgeState.status !== 'ready' || bridge === null || bridge.ns === null) {
            throw bridgeState.error instanceof Error ? bridgeState.error : new Error('remote bridge unavailable');
          }
          const args = NOARG_METHODS.has(method) || input === undefined ? [] : [input];
          const outcome = await bridge.ns[method](...args);
          if (!outcome || outcome.ok !== true) {
            const code = outcome?.error?.code ?? 'no-code';
            const reason = outcome?.error?.message ?? 'remote call failed';
            const failure = new Error(`${code}: ${reason}`);
            console.error('[sleep-memory] remote call failed:', method, failure);
            throw failure;
          }
          return outcome.value;
        }

        // ---- data hooks -----------------------------------------------------

        /** Stats snapshot plus a manual reload; null until the first result lands. */
        function useStats() {
          const [stats, setStats] = useState(null);
          const [tick, setTick] = useState(0);
          useEffect(() => {
            let alive = true;
            call('stats')
              .then((value) => { if (alive) setStats(value); })
              .catch(() => { if (alive) setStats(null); });
            return () => { alive = false; };
          }, [tick]);
          const reload = useCallback(() => setTick((n) => n + 1), []);
          return [stats, reload];
        }

        /** All association edges, loaded once on first demand; null until loaded. */
        function useEdges(enabled) {
          const [edges, setEdges] = useState(null);
          const [tick, setTick] = useState(0);
          useEffect(() => {
            if (!enabled) return undefined;
            let alive = true;
            call('edges')
              .then((value) => { if (alive) setEdges(Array.isArray(value?.edges) ? value.edges : []); })
              .catch(() => { if (alive) setEdges([]); });
            return () => { alive = false; };
          }, [enabled, tick]);
          const reload = useCallback(() => setTick((n) => n + 1), []);
          return [edges, reload];
        }

        // ---- small UI pieces ------------------------------------------------

        function Toast({ toast }) {
          if (!toast) return null;
          return h('div', { className: `sm-toast${toast.isError ? ' is-error' : ''}`, role: 'status', key: toast.seq },
            h('span', { className: 'sm-toastdot', 'aria-hidden': true }),
            h('span', null, toast.text));
        }

        function SkeletonRows({ count, label }) {
          const rows = [];
          for (let i = 0; i < count; i += 1) {
            rows.push(h('div', { className: 'sm-skel', key: i, 'aria-hidden': true },
              h('div', { className: 'sm-skbar', style: { width: '42%' } }),
              h('div', { className: 'sm-skbar', style: { width: 64, marginInlineStart: 'auto' } })));
          }
          return h('div', { className: 'sm-rows', role: 'status', 'aria-label': label }, rows);
        }

        function EmptyState({ title, hint, actionLabel, onAction }) {
          return h('div', { className: 'sm-empty' },
            h('div', { 'aria-hidden': true }, h(MemoryIcon, { size: 40 })),
            h('div', { className: 'sm-empty-title' }, title),
            hint ? h('div', null, hint) : null,
            actionLabel ? h('button', { type: 'button', className: 'sm-btn sm-btn-outline', onClick: onAction }, actionLabel) : null);
        }

        function LayerBadge({ layer }) {
          return h('span', { className: 'sm-badge is-layer' }, t(`sleep-memory.layer.${layer}`));
        }

        function MiniBar({ label, value }) {
          return h('span', { className: 'sm-bar' },
            h('span', { className: 'sm-barlabel' }, label),
            h('span', { className: 'sm-bartrack', 'aria-hidden': true },
              h('span', { className: 'sm-barfill', style: { width: `${Math.round(clamp01(value) * 100)}%` } })),
            h('span', { className: 'sm-rowmeta' }, Math.round(clamp01(value) * 100)));
        }

        /** One live memory record: badges + content + tags + metric bars. */
        function RecordRow({ item }) {
          const kindLabel = item.kind === 'fact' ? t('sleep-memory.kind.fact') : t('sleep-memory.kind.experience');
          const salient = item.layer === 'salient' && Number.isFinite(Number(item.valence));
          const meta = [
            relTime(item.lastAccessAt) || relTime(item.createdAt),
            t('sleep-memory.row.access', { n: item.accessCount ?? 0 }),
            Array.isArray(item.edges) && item.edges.length > 0
              ? t('sleep-memory.row.edgeCount', { n: item.edges.length }) : null,
          ].filter(Boolean).join(' · ');
          return h('li', { className: 'sm-row', key: item.id },
            h('div', { className: 'sm-rowhead' },
              h(LayerBadge, { layer: item.layer }),
              h('span', { className: 'sm-badge' }, kindLabel),
              salient ? h('span', {
                className: `sm-badge ${Number(item.valence) >= 0 ? 'is-salient-pos' : 'is-salient-neg'}`,
                title: t('sleep-memory.row.emotion', { v: valenceText(item.valence), a: valenceText(item.arousal) }),
              }, `${Number(item.valence) >= 0 ? '✦' : '⚠️'} ${valenceText(item.valence)} / ${valenceText(item.arousal)}`) : null,
              h('span', { className: 'sm-spring' }),
              h('span', { className: 'sm-rowmeta' }, meta)),
            h('div', { className: 'sm-rowcontent', title: item.content }, item.content),
            (Array.isArray(item.tags) && item.tags.length > 0) || (Array.isArray(item.keywords) && item.keywords.length > 0)
              ? h('div', { className: 'sm-rowtags' },
                (item.tags ?? []).map((tag) => h('span', { className: 'sm-tag', key: `t:${tag}` }, tag)),
                (item.keywords ?? []).map((kw) => h('span', { className: 'sm-tag', key: `k:${kw}` }, kw)))
              : null,
            h('div', { className: 'sm-bars' },
              h(MiniBar, { label: t('sleep-memory.row.importance'), value: item.importance }),
              h(MiniBar, { label: t('sleep-memory.row.strength'), value: item.strength })));
        }

        /** Overview card: totals, per-layer counts, superseded, edges, time span. */
        function StatsCard({ stats, onRefresh }) {
          const spanText = stats === null ? ''
            : (stats.oldest === null || stats.newest === null)
              ? (stats.total === 0 ? t('sleep-memory.stats.spanNone') : t('sleep-memory.stats.spanSingle', { at: shortDate(stats.newest) }))
              : t('sleep-memory.stats.span', { from: shortDate(stats.oldest), to: shortDate(stats.newest) });
          return h('section', { className: 'sm-card', 'aria-label': t('sleep-memory.stats.title') },
            h('div', { className: 'sm-statrow' },
              h('div', { className: 'sm-stat' },
                h('span', { className: 'sm-statnum' }, stats?.total ?? '—'),
                h('span', { className: 'sm-statlabel' }, t('sleep-memory.stats.total', { n: stats?.total ?? 0 }))),
              h('div', { className: 'sm-stat' },
                h('span', { className: 'sm-statnum' }, stats?.supersededCount ?? '—'),
                h('span', { className: 'sm-statlabel' }, t('sleep-memory.stats.superseded', { n: stats?.supersededCount ?? 0 }))),
              h('div', { className: 'sm-stat' },
                h('span', { className: 'sm-statnum' }, stats?.edgeCount ?? '—'),
                h('span', { className: 'sm-statlabel' }, t('sleep-memory.stats.edges', { n: stats?.edgeCount ?? 0 }))),
              h('span', { className: 'sm-spring' }),
              h('span', { className: 'sm-spanshot' }, spanText),
              h('button', {
                type: 'button', className: 'sm-btn sm-btn-outline sm-btn-mini', onClick: onRefresh,
                'aria-label': t('sleep-memory.stats.refresh'),
              }, t('sleep-memory.stats.refresh'))),
            h('div', { className: 'sm-statrow' },
              h('div', { className: 'sm-layers' },
                LAYERS.map((layer) => h('span', { className: 'sm-badge is-layer', key: layer },
                  `${t(`sleep-memory.layer.${layer}`)} ${stats?.byLayer?.[layer] ?? 0}`)))));
        }

        /** Salient valence×arousal scatter: ✦ positive and ⚠️ negative coloring. */
        function ScatterView({ items }) {
          const salient = items.filter((item) => item.layer === 'salient' && Number.isFinite(Number(item.valence)) && Number.isFinite(Number(item.arousal)));
          if (salient.length === 0) {
            return h('div', { className: 'sm-empty' }, h('div', { className: 'sm-empty-title' }, t('sleep-memory.scatter.empty')));
          }
          const width = 760;
          const height = 320;
          const padX = 48;
          const padY = 28;
          const xOf = (v) => padX + ((Number(v) + 1) / 2) * (width - padX * 2);
          const yOf = (a) => padY + (1 - clamp01(a)) * (height - padY * 2);
          const children = [];
          children.push(h('rect', { x: padX, y: padY, width: width - padX * 2, height: height - padY * 2, className: 'sm-scattergrid', fill: 'none' }));
          children.push(h('line', { x1: xOf(0), y1: padY, x2: xOf(0), y2: height - padY, className: 'sm-scattergrid' }));
          children.push(h('line', { x1: padX, y1: yOf(0.5), x2: width - padX, y2: yOf(0.5), className: 'sm-scattergrid' }));
          children.push(h('text', { x: xOf(-1), y: height - padY + 16, className: 'sm-scatteraxis', textAnchor: 'start' }, '-1'));
          children.push(h('text', { x: xOf(0), y: height - padY + 16, className: 'sm-scatteraxis', textAnchor: 'middle' }, '0'));
          children.push(h('text', { x: xOf(1), y: height - padY + 16, className: 'sm-scatteraxis', textAnchor: 'end' }, '+1'));
          children.push(h('text', { x: width / 2, y: height - 4, className: 'sm-scatteraxis', textAnchor: 'middle' }, t('sleep-memory.scatter.axis.valence')));
          children.push(h('text', { x: padX - 6, y: padY + 10, className: 'sm-scatteraxis', textAnchor: 'end' }, '1'));
          children.push(h('text', { x: padX - 6, y: height - padY, className: 'sm-scatteraxis', textAnchor: 'end' }, '0'));
          children.push(h('text', { x: padX - 6, y: height / 2, className: 'sm-scatteraxis', textAnchor: 'end', transform: `rotate(-90 ${padX - 6} ${height / 2})` }, t('sleep-memory.scatter.axis.arousal')));
          for (const item of salient) {
            const positive = Number(item.valence) >= 0;
            children.push(h('circle', {
              cx: xOf(item.valence), cy: yOf(item.arousal), r: 6,
              className: `sm-scatterdot ${positive ? 'is-pos' : 'is-neg'}`,
              key: item.id,
            },
            h('title', null, `${item.content.slice(0, 80)}\n✦ ${valenceText(item.valence)} / ${valenceText(item.arousal)}`)));
          }
          return h('div', { className: 'sm-scatterwrap' },
            h('svg', { className: 'sm-scatter', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('sleep-memory.scatter.title') }, children),
            h('span', { className: 'sm-scatterhint' }, t('sleep-memory.scatter.hint')));
        }

        /** Flat edge list grouped by relation, weight shown as a mini bar. */
        function EdgesView({ edges }) {
          if (edges === null) return SkeletonRows({ count: 4, label: t('sleep-memory.state.loading') });
          if (edges.length === 0) return h('div', { className: 'sm-empty' }, h('div', { className: 'sm-empty-title' }, t('sleep-memory.edges.empty')));
          const byRelation = new Map();
          for (const edge of edges) {
            const list = byRelation.get(edge.relation) ?? [];
            list.push(edge);
            byRelation.set(edge.relation, list);
          }
          const groups = [];
          for (const [relation, list] of byRelation) {
            groups.push(h('div', { className: 'sm-listhead', key: `h:${relation}`, style: { padding: '8px 0 4px' } },
              h('h3', { className: 'sm-listtitle' }, t(`sleep-memory.edges.relation.${relation}`)),
              h('span', { className: 'sm-count' }, t('sleep-memory.edges.count', { n: list.length }))));
            groups.push(h('div', { className: 'sm-edgegroup', key: `g:${relation}` },
              list.map((edge, index) => h('div', { className: 'sm-edgerow', key: `${edge.from}->${edge.to}:${index}` },
                h('span', { className: 'sm-edgeend', title: edge.from }, edge.from),
                h('span', { className: 'sm-edgearrow', 'aria-hidden': true }, '→'),
                h('span', { className: 'sm-edgeend', title: edge.to }, edge.to),
                h('span', { className: 'sm-edgeweight', 'aria-hidden': true },
                  h('span', { className: 'sm-edgeweightfill', style: { width: `${Math.round(clamp01(edge.weight) * 100)}%` } }))))));
          }
          return h('div', { className: 'sm-inner', style: { gap: 0, maxWidth: 'none' } }, groups);
        }

        /** Sleep-cycle report banner; stays until dismissed so counts are readable. */
        function SleepBanner({ report, onDismiss }) {
          if (!report) return null;
          const title = report.dryRun === true ? t('sleep-memory.sleep.previewDone') : t('sleep-memory.sleep.done');
          const phases = [
            t('sleep-memory.sleep.phase.consolidate', { n: report.consolidatedCount ?? 0 }),
            t('sleep-memory.sleep.phase.archive', { n: report.archivedCount ?? 0 }),
            t('sleep-memory.sleep.phase.forget', { n: report.deletedCount ?? 0 }),
            t('sleep-memory.sleep.phase.rem', { n: report.edgesAdded ?? 0 }),
            t('sleep-memory.sleep.phase.decay', { n: report.decayedCount ?? 0 }),
            t('sleep-memory.sleep.records', { before: report.recordsBefore ?? 0, after: report.recordsAfter ?? 0 }),
          ];
          return h('div', { className: 'sm-banner', role: 'status' },
            h('div', { className: 'sm-bannertext' },
              h('div', { className: 'sm-bannertitle' }, title),
              h('div', { className: 'sm-bannerphases' },
                phases.map((phase, index) => h('span', { className: 'sm-badge', key: index }, phase))),
              report.capacityLimited === true ? h('div', null, t('sleep-memory.sleep.capacityLimited')) : null),
            h('button', {
              type: 'button', className: 'sm-btn sm-btn-outline sm-btn-mini',
              onClick: onDismiss,
            }, t('sleep-memory.sleep.dismiss')));
        }

        // ---- memory bank page ----------------------------------------------

        function MemoryBankPage() {
          useLocale();
          const toast = useToast();
          const [stats, reloadStats] = useStats();
          const [view, setView] = useState('browse');

          // Browse state: layer filter, debounced query, one accumulating page.
          const [layer, setLayer] = useState('all');
          const [queryInput, setQueryInput] = useState('');
          const [query, setQuery] = useState('');
          const [items, setItems] = useState(null);
          const [total, setTotal] = useState(0);
          const [page, setPage] = useState(0);
          const [loading, setLoading] = useState(false);
          const queryTimer = useRef(null);

          // Edges load lazily when the tab opens.
          const [edgesList, reloadEdges] = useEdges(view === 'edges');

          // Sleep cycle state: which action is in flight, the last report banner.
          const [sleeping, setSleeping] = useState(false);
          const [previewing, setPreviewing] = useState(false);
          const [report, setReport] = useState(null);

          useEffect(() => {
            if (queryTimer.current) clearTimeout(queryTimer.current);
            queryTimer.current = setTimeout(() => setQuery(queryInput.trim()), 300);
            return () => { if (queryTimer.current) clearTimeout(queryTimer.current); };
          }, [queryInput]);

          const loadPage = useCallback(async (targetPage, append) => {
            setLoading(true);
            try {
              const outcome = await call('list', {
                layer: layer === 'all' ? undefined : layer,
                query: query === '' ? undefined : query,
                limit: PAGE_SIZE,
                offset: targetPage * PAGE_SIZE,
              });
              const next = Array.isArray(outcome?.items) ? outcome.items : [];
              setTotal(outcome?.total ?? 0);
              setItems((prev) => (append && Array.isArray(prev) ? [...prev, ...next] : next));
              setPage(targetPage);
            } catch (error) {
              if (!append) setItems([]);
              showToast(`${t('sleep-memory.toast.failed')}：${error?.message ?? error}`, true);
            } finally {
              setLoading(false);
            }
          }, [layer, query, t]);

          useEffect(() => {
            void loadPage(0, false);
          }, [loadPage]);

          const runSleep = useCallback(async (dryRun) => {
            if (dryRun) setPreviewing(true); else setSleeping(true);
            try {
              const outcome = await call('runSleep', { dryRun });
              setReport(outcome);
              reloadStats();
              reloadEdges();
              void loadPage(0, false);
            } catch {
              showToast(t('sleep-memory.sleep.failed'), true);
            } finally {
              setPreviewing(false);
              setSleeping(false);
            }
          }, [loadPage, reloadEdges, reloadStats, t]);

          const hasMore = items !== null && items.length < total;
          const filterActive = layer !== 'all' || query !== '';

          let browseBody;
          if (items === null && loading) {
            browseBody = SkeletonRows({ count: 5, label: t('sleep-memory.state.loading') });
          } else if (total === 0 && !filterActive) {
            browseBody = EmptyState({ title: t('sleep-memory.empty.title'), hint: t('sleep-memory.empty.hint') });
          } else if (items !== null && items.length === 0) {
            browseBody = EmptyState({
              title: t('sleep-memory.empty.filtered.title'),
              actionLabel: t('sleep-memory.empty.filtered.action'),
              onAction: () => { setQueryInput(''); setQuery(''); setLayer('all'); },
            });
          } else {
            browseBody = h(React.Fragment, null,
              h('ul', { className: 'sm-rows' }, (items ?? []).map((item) => h(RecordRow, { item, key: item.id }))),
              hasMore ? h('div', { style: { display: 'flex', justifyContent: 'center', padding: '10px 0 0' } },
                h('button', {
                  type: 'button', className: 'sm-btn sm-btn-outline',
                  disabled: loading,
                  onClick: () => void loadPage(page + 1, true),
                }, loading ? t('sleep-memory.browse.loadingMore') : t('sleep-memory.browse.more'))) : null);
          }

          return h('div', { className: 'sm-page' },
            h('div', { className: 'sm-inner' },
              h('div', { className: 'sm-head' },
                h('h1', { className: 'sm-title' }, t('sleep-memory.page.title'))),

              h(StatsCard, { stats, onRefresh: reloadStats }),

              h(SleepBanner, { report, onDismiss: () => setReport(null) }),

              h('div', { className: 'sm-toolbar' },
                h('div', { className: 'sm-tabs', role: 'tablist', 'aria-label': t('sleep-memory.page.title') },
                  h('button', {
                    type: 'button', className: 'sm-tab', role: 'tab',
                    'aria-selected': view === 'browse',
                    onClick: () => setView('browse'),
                  }, t('sleep-memory.browse.title')),
                  h('button', {
                    type: 'button', className: 'sm-tab', role: 'tab',
                    'aria-selected': view === 'scatter',
                    onClick: () => setView('scatter'),
                  }, t('sleep-memory.scatter.title')),
                  h('button', {
                    type: 'button', className: 'sm-tab', role: 'tab',
                    'aria-selected': view === 'edges',
                    onClick: () => setView('edges'),
                  }, t('sleep-memory.edges.title'))),
                h('span', { className: 'sm-spring' }),
                h('button', {
                  type: 'button', className: 'sm-btn sm-btn-outline',
                  disabled: previewing || sleeping,
                  'aria-label': t('sleep-memory.sleep.dryRunAria'),
                  onClick: () => void runSleep(true),
                }, previewing ? t('sleep-memory.sleep.previewing') : t('sleep-memory.sleep.dryRun')),
                h('button', {
                  type: 'button', className: 'sm-btn sm-btn-primary',
                  disabled: previewing || sleeping,
                  'aria-label': t('sleep-memory.sleep.runAria'),
                  onClick: () => void runSleep(false),
                }, h(MoonIcon, {}), sleeping ? t('sleep-memory.sleep.running') : t('sleep-memory.sleep.run'))),

              view === 'browse' ? h(React.Fragment, null,
                h('div', { className: 'sm-listhead' },
                  h('h2', { className: 'sm-listtitle' }, t('sleep-memory.browse.title')),
                  h('span', { className: 'sm-count' }, t('sleep-memory.browse.count', { n: total })),
                  h('span', { className: 'sm-spring' })),
                h('div', { className: 'sm-toolbar' },
                  h('div', { className: 'sm-toolbar-grow' },
                    h('input', {
                      className: 'sm-search', type: 'search', value: queryInput,
                      placeholder: t('sleep-memory.search'), 'aria-label': t('sleep-memory.search.aria'),
                      onChange: (event) => setQueryInput(event.target.value),
                    })),
                  h('label', { className: 'sm-visually-hidden', htmlFor: 'sm-layer' }, t('sleep-memory.filter.label')),
                  h('select', {
                    id: 'sm-layer', className: 'sm-select', value: layer,
                    'aria-label': t('sleep-memory.filter.label'),
                    onChange: (event) => setLayer(event.target.value),
                  },
                  h('option', { value: 'all' }, t('sleep-memory.filter.all')),
                  LAYERS.map((name) => h('option', { key: name, value: name }, t(`sleep-memory.layer.${name}`))))),
                browseBody) : null,

              view === 'scatter' ? h('div', { className: 'sm-listhead' },
                h('h2', { className: 'sm-listtitle' }, t('sleep-memory.scatter.title')),
                h('span', { className: 'sm-count' }, t('sleep-memory.scatter.count', { n: (items ?? []).filter((item) => item.layer === 'salient').length }))) : null,
              view === 'scatter' && items !== null ? h(ScatterView, { items }) : null,

              view === 'edges' ? h('div', { className: 'sm-listhead' },
                h('h2', { className: 'sm-listtitle' }, t('sleep-memory.edges.title')),
                h('span', { className: 'sm-count' }, edgesList === null ? '' : t('sleep-memory.edges.count', { n: edgesList.length }))) : null,
              view === 'edges' ? h(EdgesView, { edges: edgesList }) : null,

              h(Toast, { toast })));
        }

        // ---- bundle detail page inline config (plugins.bundle.config) --------

        const CONFIG_FIELD_ORDER = ['injectEnabled', 'recallBudget', 'injectBudget', 'sleepIntervalMinutes'];

        /** Initial free-typing drafts: booleans stay booleans, numbers become raw strings. */
        function configDraftFrom(fields) {
          const draft = {};
          for (const key of CONFIG_FIELD_ORDER) {
            const field = fields[key];
            if (!field) continue;
            draft[key] = field.type === 'boolean'
              ? field.value === true
              : (typeof field.value === 'number' && Number.isFinite(field.value) ? String(field.value) : '');
          }
          return draft;
        }

        /** Whole-number parse clamped by the field's range; null when invalid. */
        function configParseNumber(raw, field) {
          if (!/^-?\d+$/.test(raw)) return null;
          const parsed = Number(raw);
          if (!Number.isSafeInteger(parsed) || parsed < field.min || parsed > field.max) return null;
          return parsed;
        }

        /**
         * Inline config on the plugin-manager bundle detail page. The slot only
         * supplies `{ view }` — all state comes from the plugin's own Remote
         * bridge (`getConfig`/`setConfig`), whose writes persist through the
         * host configEditor overlay and take effect immediately.
         */
        function BundleConfigSection({ view }) {
          useLocale();
          const [state, setState] = useState({ status: 'loading', fields: null });
          const [draft, setDraft] = useState({});
          const [busy, setBusy] = useState(false);
          const [saved, setSaved] = useState(false);
          const [error, setError] = useState(null);

          const load = useCallback(async () => {
            try {
              const result = await call('getConfig');
              const fields = result && typeof result === 'object' && result.fields ? result.fields : {};
              setState({ status: 'ready', fields });
              setDraft(configDraftFrom(fields));
              setSaved(false);
            } catch (cause) {
              setState({ status: 'error', fields: null });
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }, []);

          useEffect(() => { void load(); }, [load]);

          if (view !== 'page') {
            return h('div', { className: 'sm-config-note' }, t('sleep-memory.config.summary'));
          }
          if (state.status === 'loading') {
            return h('div', { className: 'sm-config-note' }, t('sleep-memory.config.loading'));
          }
          if (state.status === 'error') {
            return h('div', { className: 'sm-config-note' }, `${t('sleep-memory.config.loadFailed')}：${error ?? ''}`);
          }

          const fields = state.fields;
          const parsed = {};
          let valid = true;
          for (const key of CONFIG_FIELD_ORDER) {
            const field = fields[key];
            if (!field) continue;
            if (field.type === 'boolean') {
              parsed[key] = draft[key] === true;
            } else {
              parsed[key] = configParseNumber(String(draft[key] ?? ''), field);
              if (parsed[key] === null) valid = false;
            }
          }
          const dirty = CONFIG_FIELD_ORDER.some((key) => fields[key] && parsed[key] !== fields[key].value);

          const apply = async (changes) => {
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
              await call('setConfig', { changes });
              await load();
              setSaved(true);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          };

          const save = () => {
            if (busy || !dirty || !valid) return;
            const changes = {};
            for (const key of CONFIG_FIELD_ORDER) {
              if (fields[key] && parsed[key] !== fields[key].value) changes[key] = parsed[key];
            }
            void apply(changes);
          };

          const setBoolean = (key) => {
            setSaved(false);
            setDraft((current) => ({ ...current, [key]: !(current[key] === true) }));
          };
          const setNumber = (key, raw) => {
            setSaved(false);
            setDraft((current) => ({ ...current, [key]: raw }));
          };
          const resetButton = (key) => h('button', {
            type: 'button', className: 'sm-btn sm-btn-outline sm-config-reset',
            disabled: busy, onClick: () => void apply({ [key]: null }),
          }, t('sleep-memory.config.reset'));

          const rows = [];
          rows.push(h('label', { className: 'sm-config-row', key: 'injectEnabled' },
            h('span', { className: 'sm-config-label' }, t('sleep-memory.config.field.injectEnabled')),
            h('input', {
              type: 'checkbox', className: 'sm-config-check', disabled: busy,
              checked: parsed.injectEnabled === true,
              onChange: () => setBoolean('injectEnabled'),
            }),
            h('span', { className: 'sm-config-hint' }, t('sleep-memory.config.field.injectEnabled.hint')),
            fields.injectEnabled && fields.injectEnabled.overridden ? resetButton('injectEnabled') : null));

          for (const key of ['recallBudget', 'injectBudget', 'sleepIntervalMinutes']) {
            const field = fields[key];
            if (!field) continue;
            rows.push(h('label', { className: 'sm-config-row', key },
              h('span', { className: 'sm-config-label' }, t(`sleep-memory.config.field.${key}`)),
              h('input', {
                type: 'number', className: 'sm-search sm-config-num', min: field.min, max: field.max, step: 1,
                value: String(draft[key] ?? ''), disabled: busy,
                onChange: (event) => setNumber(key, event.target.value),
              }),
              h('span', { className: 'sm-config-hint' }, t(`sleep-memory.config.field.${key}.hint`)),
              field.overridden ? resetButton(key) : null));
          }

          return h('div', { className: 'sm-config' },
            rows,
            h('div', { className: 'sm-config-row sm-config-actions', key: 'actions' },
              h('button', {
                type: 'button', className: 'sm-btn sm-btn-primary',
                disabled: busy || !dirty || !valid, onClick: save,
              }, t(busy ? 'sleep-memory.config.saving' : 'sleep-memory.config.save')),
              saved && !dirty ? h('span', { className: 'sm-config-hint' }, t('sleep-memory.config.saved')) : null),
            error ? h('div', { className: 'sm-config-error' }, `${t('sleep-memory.config.saveFailed')}：${error}`) : null);
        }

        // ---- slot registration ----------------------------------------------

        /**
         * Declare-then-register through `slots.inject`: it waits for the slot's
         * declaration and re-runs on every declaration epoch, so each re-run
         * disposes the entry it made last time (a second register at the same
         * priority throws). A duplicate reporting another live fiber makes this
         * half retry at a lower priority so it still owns a live entry.
         */
        function bind(label, key, register) {
          try {
            return ctx.slots.inject(key, () => {
              let handle;
              const dispose = () => {
                const current = handle;
                handle = undefined;
                try { current?.(); } catch { /* already gone */ }
              };
              const run = (options) => {
                try {
                  handle = options === undefined ? register() : register(options);
                  return true;
                } catch (error) {
                  const message = error && error.message ? String(error.message) : '';
                  if (message.includes('already has a registration') || message.includes('already has an entry')) return false;
                  if (typeof console !== 'undefined') console.error(`[sleep-memory] ${label}: ${message}`);
                  return true;
                }
              };
              if (!run(undefined) && typeof register.priority === 'number') {
                for (let step = 1; step <= 4; step += 1) {
                  if (run({ priority: register.priority - step })) break;
                }
              }
              return () => dispose();
            });
          } catch (error) {
            if (typeof console !== 'undefined') console.error(`[sleep-memory] ${label}: ${error?.message ?? error}`);
            return undefined;
          }
        }

        ctx.effect(() => {
          // A second application on one page (hot reinstall) re-registers the
          // same namespace+locale and throws; the dictionaries are identical.
          let disposeLocale = null;
          try {
            disposeLocale = ctx.locale.register(NS, { zh: ZH, en: EN });
          } catch (error) {
            const message = error && error.message ? String(error.message) : '';
            if (!message.includes('already has locale') && typeof console !== 'undefined') {
              console.error(`[sleep-memory] locale: ${message}`);
            }
          }

          const disposers = [];
          const panellist = bind('panellist', 'sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: SLOT_ID,
            order: 27,
            locale: NS,
            label: () => t('sleep-memory.panel'),
          }, MemorySidebarIcon));
          if (typeof panellist === 'function') disposers.push(panellist);

          const main = bind('main', 'main', () => ctx.slots.register({
            name: 'main',
            key: SLOT_ID,
          }, MemoryBankPage));
          if (typeof main === 'function') disposers.push(main);

          const bundleConfig = bind('bundleConfig', 'plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config',
            key: PACKAGE_ID,
            locale: NS,
          }, BundleConfigSection));
          if (typeof bundleConfig === 'function') disposers.push(bundleConfig);

          // Mount the Remote bridge eagerly so the stats card has data on the
          // first paint rather than after a round trip from the panel.
          void mountBridge();

          return () => {
            for (const dispose of disposers) {
              try { dispose(); } catch { /* already disposed */ }
            }
            try { disposeLocale?.(); } catch { /* already gone */ }
            try { unsubscribeLocale?.(); } catch { /* already gone */ }
            try { bridge?.disposer?.(); } catch { /* already torn down */ }
            bridge = null;
            bridgeState = { status: 'idle', error: null };
            if (toastTimer) clearTimeout(toastTimer);
            toastTimer = null;
            toastState.current = null;
            localeListeners.clear();
            toastListeners.clear();
          };
        });
      },
    };
  },
});
