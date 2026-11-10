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
    // 旧 profile 使用作用域依赖别名，宿主配置槽按安装时的依赖键匹配。
    const CONFIG_PACKAGE_IDS = [PACKAGE_ID, '@errorcode864/dsh-sleep-memory'];
    const SLOT_ID = 'sleep-memory';
    const NS = 'sleep-memory';

    const REMOTE_SERVICE = 'sleepMemoryApi';
    const REMOTE_NAMESPACE = 'sleepMemoryApi';
    const NOARG_METHODS = new Set(['stats', 'edges', 'getConfig', 'status']);
    const REMOTE_METHODS = ['stats', 'list', 'edges', 'runSleep', 'getConfig', 'setConfig', 'status', 'getRecord', 'manage', 'scope'];
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

      'sleep-memory.stats.title': '全库概览',
      'sleep-memory.stats.total': '{n} 条活记录',
      'sleep-memory.stats.superseded': '{n} 条未参与自动召回',
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
.sm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 4px; }
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

.sm-rows { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); overflow: hidden; }
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

/* 管理表单沿用宿主色板，展开后保持独立字段与可读的确认区域。 */
.sm-management { display: block; padding: 12px 14px; overflow-wrap: anywhere; }
.sm-management > summary { cursor: pointer; font-weight: 600; }
.sm-management > label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.sm-management .sm-select { max-width: 100%; align-self: flex-start; }
.sm-management textarea.sm-search { height: auto; min-height: 100px; padding: 8px 10px; resize: vertical; }
.sm-management .sm-btn { margin: 4px 8px 4px 0; }
.sm-management p { margin: 10px 0; }
.sm-management [role="status"] { padding: 10px; margin-top: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }
.sm-project-picker { position: relative; flex: 0 1 220px; min-width: 160px; }
.sm-project-picker > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; list-style: none; width: 100%; }
.sm-project-picker > summary::-webkit-details-marker { display: none; }
.sm-project-picker > summary span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-project-menu { position: absolute; z-index: 10; top: calc(100% + 6px); left: 0; width: min(300px, calc(100vw - 32px)); padding: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv2); }
.sm-project-options { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto; margin-top: 8px; }
.sm-project-option { width: 100%; height: auto; min-height: 32px; justify-content: flex-start; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.sm-project-option[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sm-project-message { margin: 8px 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-group-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-group-toggle input { margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.sm-project-group { border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.sm-project-group + .sm-project-group { margin-top: 12px; }
.sm-project-group > summary { padding: 10px 14px; font-size: 13px; font-weight: 600; cursor: pointer; overflow-wrap: anywhere; }
.sm-project-group > summary .sm-count { margin-left: 8px; font-weight: 400; }
.sm-project-group .sm-rows { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); border-radius: 0; }
.sm-tag-more { height: 20px; padding: 0 5px; font-size: 11px; }
.sm-stats-scope { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sm-btn-quiet { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.sm-runtime-summary { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; min-height: 32px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.sm-runtime-state { display: flex; align-items: center; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.sm-runtime-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.sm-runtime-summary.is-working .sm-runtime-state { color: var(--dsw-alias-brand-primary); }
.sm-runtime-summary.is-error { padding: 4px 10px; border-radius: var(--dsw-radius-sm); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1)); }
.sm-runtime-summary.is-error .sm-runtime-state { color: var(--dsw-alias-state-error-primary); }
.sm-dialog { position: fixed; inset: 0; width: min(760px, calc(100vw - 48px)); max-width: none; height: min(640px, calc(100dvh - 64px)); max-height: calc(100dvh - 64px); margin: auto; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; box-shadow: var(--dsw-shadow-lv2); overflow: hidden; }
.sm-dialog[open] { display: flex; flex-direction: column; }
.sm-dialog::backdrop { background: color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent); }
.sm-dialog-head { display: flex; align-items: center; justify-content: space-between; flex: none; gap: 12px; padding: 18px 24px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sm-dialog-title { margin: 0; font-size: 17px; line-height: 24px; font-weight: 600; }
.sm-dialog-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px 24px; overflow-wrap: anywhere; }
.sm-manager-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding-bottom: 12px; margin-bottom: 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sm-manager-tabs .sm-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sm-manager-section { padding: 0; }
.sm-manager-section h3 { margin: 0 0 12px; font-size: 14px; line-height: 22px; font-weight: 600; }
.sm-manager-section p { margin: 10px 0; }
.sm-runtime-info { display: flex; flex-direction: column; gap: 14px; margin: 0; }
.sm-runtime-info > div { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; }
.sm-runtime-info dt { flex: none; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sm-runtime-info dd { margin: 0; min-width: 0; text-align: right; overflow-wrap: anywhere; font-size: 13px; }
.sm-runtime-counts { border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 20px; padding-top: 16px; }
.sm-runtime-counts summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-runtime-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-runtime-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.sm-runtime-counters { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 20px; }
.sm-runtime-counters th, .sm-runtime-counters td { text-align: left; vertical-align: top; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sm-runtime-counters th { width: 76px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.sm-rowtop { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; }
.sm-rowtop .sm-rowmeta { min-width: 0; overflow-wrap: anywhere; }
.sm-record-open { flex: none; margin-left: auto; height: 26px; padding: 0 6px; font-size: 12px; }
.sm-record-section + .sm-record-section { border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 20px; padding-top: 18px; }
.sm-record-section h3 { font-size: 14px; line-height: 22px; font-weight: 600; margin: 0 0 12px; }
.sm-record-section p { margin: 8px 0; }
.sm-record-original { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 24px; }
.sm-record-provenance { margin-top: 18px; }
.sm-record-history { margin-top: 12px; padding: 12px 0; }
.sm-record-history + .sm-record-history { border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-record-pagination { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.sm-dialog .sm-management { padding: 0; }
.sm-dialog .sm-card.sm-management { padding: 12px 14px; }
.sm-dialog input[type="file"] { max-width: 100%; }
@media (max-width: 480px) {
  .sm-page { padding: 20px 16px 32px; }
  .sm-dialog { width: calc(100vw - 24px); max-height: calc(100dvh - 32px); }
  .sm-dialog-head { padding: 14px 16px; }
  .sm-dialog-body { padding: 16px; }
  .sm-tabs { flex-wrap: wrap; }
}

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

        /** 标签优先展示，关键词补充；大小写和空白差异不重复占用列表空间。 */
        function collectRecordLabels(item) {
          const seen = new Set();
          return [...(item.tags ?? []), ...(item.keywords ?? [])].map((label) => String(label).trim()).filter((label) => {
            const key = label.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }

        /** 项目由全库记录提供，工作区名称仅作展示，不推断或修改历史归属。 */
        function ProjectPicker({ projects, projectId, globalOnly, onChange }) {
          const [search, setSearch] = useState('');
          const pickerRef = useRef(null);
          const searchRef = useRef(null);
          const selected = globalOnly ? '全局记忆' : projectId
            ? projects.find((project) => project.projectId === projectId)?.title ?? projectId : '全部项目';
          useEffect(() => {
            const dismiss = (event) => {
              if (pickerRef.current?.open && !pickerRef.current.contains(event.target)) pickerRef.current.open = false;
            };
            document.addEventListener('pointerdown', dismiss);
            return () => document.removeEventListener('pointerdown', dismiss);
          }, []);
          const choose = (nextProjectId, nextGlobalOnly) => {
            onChange({ projectId: nextProjectId, globalOnly: nextGlobalOnly });
            setSearch('');
            if (pickerRef.current) {
              pickerRef.current.open = false;
              pickerRef.current.querySelector('summary').focus();
            }
          };
          const text = search.trim().toLowerCase();
          const matches = projects.filter((project) => project.projectId !== null
            && [project.title, project.projectId].some((value) => value.toLowerCase().includes(text)));
          return h('details', {
            className: 'sm-project-picker', ref: pickerRef,
            onToggle: (event) => { if (event.currentTarget.open) searchRef.current?.focus(); },
            onKeyDown: (event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              if (pickerRef.current) { pickerRef.current.open = false; pickerRef.current.querySelector('summary').focus(); }
            },
          },
          h('summary', { className: 'sm-btn sm-btn-outline', 'aria-label': '项目筛选', title: selected },
            h('span', null, selected), h('span', { 'aria-hidden': true }, '⌄')),
          h('div', { className: 'sm-project-menu' },
            h('input', { ref: searchRef, className: 'sm-search', type: 'search', value: search,
              'aria-label': '搜索项目', placeholder: '搜索项目名称或标识', onChange: (event) => setSearch(event.target.value) }),
            h('div', { className: 'sm-project-options', role: 'group', 'aria-label': '项目范围' },
              h('button', { type: 'button', className: 'sm-btn sm-btn-quiet sm-project-option',
                'aria-pressed': !projectId && !globalOnly, onClick: () => choose('', false) }, '全部项目'),
              h('button', { type: 'button', className: 'sm-btn sm-btn-quiet sm-project-option',
                'aria-pressed': globalOnly, onClick: () => choose('', true) }, '全局记忆'),
              ...matches.map((project) => h('button', { key: project.projectId, type: 'button',
                className: 'sm-btn sm-btn-quiet sm-project-option', title: project.projectId,
                'aria-pressed': !globalOnly && projectId === project.projectId,
                onClick: () => choose(project.projectId, false) }, project.title))),
            matches.length === 0 ? h('p', { className: 'sm-project-message' }, text ? '没有匹配的项目' : '暂无项目专属记忆') : null));
        }

        /** 列表只保留摘要，原文、来源与纠正管理在统一弹窗中查看。 */
        function RecordRow({ item, onChanged, projectTitle, hideProject = false }) {
          const [detailOpen, setDetailOpen] = useState(false);
          const [detail, setDetail] = useState(null);
          const [detailBusy, setDetailBusy] = useState(false);
          const [detailError, setDetailError] = useState('');
          const loadDetail = async (offset = 0) => {
            setDetailBusy(true);
            setDetailError('');
            try {
              const result = await call('getRecord', { id: item.id, offset, limit: 5 });
              if (result.code) throw new Error(result.message);
              setDetail(result);
            } catch (error) {
              setDetailError(String(error.message ?? error));
            } finally {
              setDetailBusy(false);
            }
          };
          const kindLabel = item.kind === 'fact' ? t('sleep-memory.kind.fact') : t('sleep-memory.kind.experience');
          const labels = collectRecordLabels(item);
          const salient = item.layer === 'salient' && Number.isFinite(Number(item.valence));
          const meta = [
            relTime(item.lastAccessAt) || relTime(item.createdAt),
            t('sleep-memory.row.access', { n: item.accessCount ?? 0 }),
            Array.isArray(item.edges) && item.edges.length > 0
              ? t('sleep-memory.row.edgeCount', { n: item.edges.length }) : null,
          ].filter(Boolean).join(' · ');
          return h('li', { className: 'sm-row', key: item.id },
            h('div', { className: 'sm-rowtop' },
              h('span', { className: 'sm-rowmeta' },
                `${hideProject ? '' : `范围：${projectTitle ?? item.projectId ?? '全局'} · `}${STATE_LABELS[item.lifecycle?.state ?? 'active']}`),
              h('button', {
                type: 'button', className: 'sm-btn sm-btn-quiet sm-record-open', disabled: detailBusy,
                onClick: () => { setDetailOpen(true); void loadDetail(); },
              }, '查看原文与来源')),
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
            labels.length > 0
              ? h('div', { className: 'sm-rowtags' },
                labels.slice(0, 4).map((label) => h('span', { className: 'sm-tag', key: label }, label)),
                labels.length > 4 ? h('button', { type: 'button', className: 'sm-btn sm-btn-quiet sm-tag-more',
                  'aria-label': `查看全部 ${labels.length} 个标签`, onClick: () => { setDetailOpen(true); void loadDetail(); } }, `+${labels.length - 4}`) : null)
              : null,
            h(MemoryDialog, { id: `sm-record-${item.id}`, title: '原文与来源', open: detailOpen, onClose: () => setDetailOpen(false) },
              detailBusy ? h('p', { className: 'sm-runtime-note', role: 'status' }, '正在读取原文…') : null,
              detailError ? h('div', { className: 'sm-runtime-error', role: 'alert' },
                h('p', null, `读取失败：${detailError}`),
                h('button', { className: 'sm-btn sm-btn-outline', type: 'button', disabled: detailBusy, onClick: () => void loadDetail() }, '重新读取')) : null,
              detail ? h(React.Fragment, null,
                h('section', { className: 'sm-record-section', 'aria-label': '记忆原文' },
                  h('h3', null, '记忆原文'),
                  h('p', { className: 'sm-record-original' }, detail.record.content),
                  h('div', { className: 'sm-bars' },
                    h(MiniBar, { label: t('sleep-memory.row.importance'), value: detail.record.importance }),
                    h(MiniBar, { label: t('sleep-memory.row.strength'), value: detail.record.strength })),
                  labels.length ? h('div', { className: 'sm-rowtags', 'aria-label': '全部标签与关键词' },
                    collectRecordLabels(detail.record).map((label) => h('span', { className: 'sm-tag', key: label }, label))) : null,
                  h('dl', { className: 'sm-runtime-info sm-record-provenance' },
                    h('div', null, h('dt', null, '记忆 ID'), h('dd', null, detail.record.id)),
                    h('div', null, h('dt', null, '范围'), h('dd', null, detail.record.projectId ?? '全局')),
                    h('div', null, h('dt', null, '有效性'), h('dd', null, `${STATE_LABELS[detail.lifecycle.state]}${detail.lifecycle.reason ? ` · ${detail.lifecycle.reason}` : ''}`)),
                    h('div', null, h('dt', null, '自动召回'), h('dd', null, detail.current ? '参与' : '未参与'))),
                  detail.replacedBy ? h('p', { className: 'sm-runtime-note' }, `替代记忆：${detail.replacedBy}`) : null),
                h('section', { className: 'sm-record-section', 'aria-label': '来源信息' },
                  h('h3', null, '来源信息'),
                  h('dl', { className: 'sm-runtime-info' },
                    h('div', null, h('dt', null, '来源类型'), h('dd', null, SOURCE_LABELS[detail.record.source?.kind] ?? detail.record.source?.kind ?? '未记录')),
                    h('div', null, h('dt', null, '用户确认'), h('dd', null,
                      detail.record.source?.confirmed === true ? '已确认' : detail.record.source?.confirmed === false ? '未确认' : '未记录')),
                    detail.record.source?.sessionId ? h('div', null, h('dt', null, '来源会话'), h('dd', null, detail.record.source.sessionId)) : null,
                    detail.record.source?.messageId ? h('div', null, h('dt', null, '来源消息'), h('dd', null, detail.record.source.messageId)) : null)),
                h('section', { className: 'sm-record-section', 'aria-label': '纠正记录与管理' },
                  detail.totalChain > 1 ? h('details', null,
                    h('summary', null, `纠正链 · ${detail.totalChain} 条`),
                    ...detail.chain.map((record) => h('div', { className: 'sm-record-history', key: record.id },
                      h('code', null, record.id), h('p', { className: 'sm-record-original' }, record.content)))) : null,
                  h(RecordEditor, { detail, onChanged: () => { void loadDetail(); onChanged?.(); } })),
                h('section', { className: 'sm-record-section', 'aria-label': '来源记录' },
                  h('h3', null, `来源记录 · ${detail.totalSources} 条`),
                  detail.totalSources === 0 ? h('p', { className: 'sm-runtime-note' }, '没有关联来源记录。') : null,
                  ...detail.sources.map((source) => h('div', { className: 'sm-record-history', key: source.id },
                    h('code', null, source.id), h('p', { className: 'sm-record-original' }, source.content)))),
                h('div', { className: 'sm-record-pagination' },
                  detail.offset > 0 ? h('button', { className: 'sm-btn sm-btn-outline', type: 'button', disabled: detailBusy, onClick: () => void loadDetail(Math.max(0, detail.offset - 5)) }, '上一页来源') : null,
                  detail.offset + detail.limit < Math.max(detail.totalSources, detail.totalChain)
                    ? h('button', { className: 'sm-btn sm-btn-outline', type: 'button', disabled: detailBusy, onClick: () => void loadDetail(detail.offset + detail.limit) }, '下一页来源') : null)) : null));
        }

        const STATE_LABELS = { active: '有效', review: '待复核', invalid: '已失效' };
        const SCOPE_LABELS = { explicit: '显式指定', session: '会话绑定', workspace: '工作区', config: '插件配置', global: '全局回退' };
        const SOURCE_LABELS = { user: '用户', model: '模型推断', tool: '工具', import: '导入', unknown: '未记录' };
        const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

        /** 纠正前展示新旧正文，状态变更必须先取得服务端影响计划。 */
        function RecordEditor({ detail, onChanged }) {
            const [mode, setMode] = useState('state');
            const [content, setContent] = useState('');
            const [state, setState] = useState('review');
            const [reason, setReason] = useState('');
            const [plan, setPlan] = useState(null);
            const [busy, setBusy] = useState(false);
            const [message, setMessage] = useState('');
            useEffect(() => { setPlan(null); }, [detail]);
            const invalidate = (setter) => (event) => { setter(event.target.value); setPlan(null); setMessage(''); };
            const submit = async (confirm) => {
                setBusy(true); setMessage('');
                try {
                    const base = { id: detail.record.id, projectId: detail.record.projectId ?? null };
                    if (!confirm && mode === 'correct') {
                        setPlan({ mode, content: content.trim() });
                    } else if (mode === 'correct') {
                        await call('manage', { ...base, action: 'correct', content: plan.content, source: { kind: 'user', confirmed: true } });
                        setPlan(null); setContent(''); setMessage('已纠正，历史原文保留。'); onChanged?.();
                    } else {
                        const result = await call('manage', {
                            ...base, action: 'setState', state, reason, dryRun: !confirm,
                            ...(confirm ? { planToken: plan.planToken } : {}),
                        });
                        if (confirm) { setPlan(null); setMessage('有效性已更新，历史原文保留。'); onChanged?.(); }
                        else setPlan(result);
                    }
                } catch (error) {
                    setPlan(null); setMessage(`操作失败：${error.message}`);
                } finally { setBusy(false); }
            };
            return h('details', { className: 'sm-card sm-management' },
                h('summary', null, '纠正与有效性管理'),
                h('label', null, '管理操作',
                    h('select', { className: 'sm-select', value: mode, disabled: busy, onChange: invalidate(setMode) },
                        h('option', { value: 'state' }, '整条纠正链有效性'),
                        detail.current && detail.record.kind === 'fact' && detail.record.layer !== 'deep'
                            ? h('option', { value: 'correct' }, '纠正当前事实') : null)),
                mode === 'correct'
                    ? h('label', null, '完整的新事实', h('textarea', {
                        className: 'sm-search', rows: 4, value: content, disabled: busy,
                        'aria-label': '完整的新事实', onChange: invalidate(setContent),
                    }))
                    : h(React.Fragment, null,
                        h('label', null, '目标状态', h('select', {
                            className: 'sm-select', value: state, disabled: busy,
                            'aria-label': '目标状态', onChange: invalidate(setState),
                        }, Object.entries(STATE_LABELS).map(([key, label]) => h('option', { key, value: key }, label)))),
                        h('label', null, '变更原因', h('input', {
                            className: 'sm-search', value: reason, maxLength: 1000, disabled: busy,
                            'aria-label': '变更原因', onChange: invalidate(setReason),
                        }))),
                plan ? h('div', { role: 'status', style: { overflowWrap: 'anywhere' } },
                    mode === 'correct'
                        ? h(React.Fragment, null, h('p', null, `原事实：${detail.record.content}`), h('p', null, `新事实：${plan.content}`))
                        : h(React.Fragment, null,
                            h('p', null, `整链 ${plan.chainIds.length} 条，影响 ${plan.affectedIds.length} 条记忆或概要。`),
                            h('p', null, `链内 ID：${plan.chainIds.join('、')}`),
                            h('p', null, `影响 ID：${plan.affectedIds.join('、') || '无'}`)),
                    h('button', { className: 'sm-btn sm-btn-primary', type: 'button', disabled: busy, onClick: () => void submit(true) }, '确认变更')) : null,
                h('button', {
                    className: 'sm-btn sm-btn-outline', type: 'button',
                    disabled: busy || (mode === 'correct' ? !content.trim() : !reason.trim()),
                    onClick: () => void submit(false),
                }, busy ? '处理中…' : '预览变更'),
                message ? h('p', { role: 'status' }, message) : null);
        }

        /** 会话选择与项目绑定使用明确 ID，空项目表示全局，释放后回退自动范围。 */
        function ScopePanel() {
            const [sessionId, setSessionId] = useState('');
            const [projectId, setProjectId] = useState('');
            const [data, setData] = useState(null);
            const [busy, setBusy] = useState(false);
            const [error, setError] = useState('');
            useEffect(() => {
                let alive = true;
                call('scope', sessionId ? { sessionId } : {})
                    .then((result) => { if (alive) { setData(result); setProjectId(result.scope.projectId ?? ''); setError(''); } })
                    .catch((cause) => { if (alive) setError(cause.message); });
                return () => { alive = false; };
            }, [sessionId]);
            const bind = async (release) => {
                setBusy(true); setError('');
                try {
                    const result = await call('manage', { action: 'bind', sessionId, projectId: projectId.trim() || null, release });
                    setData(result); setProjectId(result.scope.projectId ?? '');
                } catch (cause) { setError(cause.message); }
                finally { setBusy(false); }
            };
            return h('section', { className: 'sm-management sm-manager-section', 'aria-label': '会话与项目范围' },
                h('h3', null, '会话与项目范围'),
                h('p', null, '选择会话查看自动范围；绑定仅影响今后的写入与检索，不迁移已有记忆。'),
                h('label', null, '会话 ID', h('input', {
                    className: 'sm-search', list: 'sm-session-options', value: sessionId, disabled: busy,
                    'aria-label': '会话 ID', onChange: (event) => { setSessionId(event.target.value); setData(null); },
                })),
                h('datalist', { id: 'sm-session-options' }, (data?.sessions ?? []).map((id) => h('option', { key: id, value: id }))),
                data ? h('p', null, `${sessionId ? '所选会话' : '无会话上下文'}：${data.scope.projectId ?? '全局'} · 来源：${SCOPE_LABELS[data.scope.source]}`) : null,
                data?.scope.source === 'global' ? h('p', null, '未绑定项目，当前回退全局范围。') : null,
                h('label', null, '项目标识（留空为全局）', h('input', {
                    className: 'sm-search', value: projectId, maxLength: 200, disabled: busy,
                    'aria-label': '绑定项目标识', onChange: (event) => setProjectId(event.target.value),
                })),
                h('button', { className: 'sm-btn sm-btn-outline', type: 'button', disabled: busy || !sessionId.trim() || !data, onClick: () => void bind(false) }, '保存会话绑定'),
                h('button', { className: 'sm-btn sm-btn-outline', type: 'button', disabled: busy || !sessionId.trim() || !data, onClick: () => void bind(true) }, '释放会话绑定'),
                error ? h('p', { role: 'alert' }, `范围操作失败：${error}`) : null);
        }

        /** 文件在浏览器中选择与下载；导入持有同一份预演快照，修改文件后必须重新预演。 */
        function BackupPanel({ onChanged }) {
            const [backup, setBackup] = useState(null);
            const [plan, setPlan] = useState(null);
            const [busy, setBusy] = useState(false);
            const [message, setMessage] = useState('');
            const selection = useRef(0);
            const choose = async (event) => {
                const revision = ++selection.current;
                setBackup(null); setPlan(null); setMessage('');
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                    if (!file.name.toLowerCase().endsWith('.json') || file.size > MAX_BACKUP_BYTES) {
                        throw new Error('请选择不超过 10 MiB 的 JSON 备份文件');
                    }
                    const value = JSON.parse(await file.text());
                    if (revision === selection.current) setBackup(value);
                } catch (error) { if (revision === selection.current) setMessage(`文件读取失败：${error.message}`); }
            };
            const run = async (action, dryRun = true) => {
                setBusy(true); setMessage('');
                try {
                    if (action === 'export') {
                        const result = await call('manage', { action });
                        const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json;charset=utf-8' });
                        if (blob.size > MAX_BACKUP_BYTES) throw new Error('备份超过界面 10 MiB 限制，请使用管理工具导出');
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url; link.download = `sleep-memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                        setMessage('已生成备份下载，包含历史原文及来源。');
                    } else {
                        const result = await call('manage', { action, backup, dryRun });
                        if (dryRun) setPlan(result);
                        else { setPlan(null); setMessage(`导入完成：新增 ${result.imported} 条，跳过 ${result.skipped} 条。`); onChanged?.(); }
                    }
                } catch (error) {
                    setPlan(null); setMessage(`操作失败：${error.message}。导入中断时请保留原文件，重新预演后重试。`);
                } finally { setBusy(false); }
            };
            return h('section', { className: 'sm-management sm-manager-section', 'aria-label': '备份与恢复' },
                h('h3', null, '备份与恢复'),
                h('p', null, '备份包含全库历史与来源。导入先预演；同 ID 异内容会拒绝，发生 I/O 中断可用原文件重试。'),
                h('button', { className: 'sm-btn sm-btn-outline', type: 'button', disabled: busy, onClick: () => void run('export') }, '下载 JSON 备份'),
                h('label', null, '选择备份文件（最大 10 MiB）', h('input', { type: 'file', accept: '.json,application/json', disabled: busy, onChange: choose })),
                h('button', { className: 'sm-btn sm-btn-outline', type: 'button', disabled: busy || !backup, onClick: () => void run('import') }, '预演导入'),
                plan ? h('div', { role: 'status' },
                    h('p', null, `将新增 ${plan.planned} 条，跳过 ${plan.skipped} 条。`),
                    h('button', { className: 'sm-btn sm-btn-primary', type: 'button', disabled: busy, onClick: () => void run('import', false) }, '确认导入')) : null,
                message ? h('p', { role: 'status' }, message) : null);
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
                  `${t(`sleep-memory.layer.${layer}`)} ${stats?.byLayer?.[layer] ?? 0}`))),
              h('span', { className: 'sm-stats-scope' }, t('sleep-memory.stats.title'))));
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

        /** 摘要与详情共享轮询，手动整理结束后立即刷新，避免侧栏内重复请求。 */
        function useRuntimeStatus(sleeping) {
          const [state, setState] = useState(null);
          const [error, setError] = useState('');
          useEffect(() => {
            let active = true;
            const refresh = async () => {
              try {
                const result = await call('status');
                if (active) { setState(result); setError(''); }
              } catch (cause) {
                if (active) setError(String(cause.message ?? cause));
              }
            };
            void refresh();
            const timer = setInterval(refresh, 10000);
            return () => { active = false; clearInterval(timer); };
          }, [sleeping]);
          return { state, error };
        }

        /** 摘要带日期以区分跨日调度，详情保留完整本地时间。 */
        function formatRuntimeTime(value, compact = false) {
          if (!value) return '暂无记录';
          return new Date(value).toLocaleString('zh-CN', compact
            ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
            : undefined);
        }

        function RuntimeSummary({ state, error, sleeping, onOpen }) {
          const working = sleeping || state?.sleeping;
          const failed = Boolean(error || (!working && (state?.schedule?.lastError || state?.lastSleepError)));
          const label = error ? '状态读取失败，请查看详情'
            : working ? '正在整理记忆…'
              : failed ? '上次整理失败，请查看详情'
                : !state ? '正在读取运行状态…'
                  : state.nextSleepAt ? `空闲 · 下次整理 ${formatRuntimeTime(state.nextSleepAt, true)}`
                    : '空闲 · 定时整理未启用';
          return h('div', { className: `sm-runtime-summary${failed ? ' is-error' : working ? ' is-working' : ''}`, 'aria-label': '记忆运行摘要' },
            h('span', { className: 'sm-runtime-state', role: failed ? 'alert' : 'status' },
              h('span', { className: 'sm-runtime-dot', 'aria-hidden': true }), label),
            h('button', { type: 'button', className: 'sm-btn sm-btn-quiet', onClick: onOpen }, failed ? '查看原因' : '运行详情'));
        }

        /** 运行详情区分持久调度与本次加载计数，零计数默认收起。 */
        function RuntimeStatus({ state, error, sleeping }) {
          const hasActivity = state && [state.scoring, state.expansion, state.injection]
            .some((counters) => Object.values(counters ?? {}).some((value) => value > 0));
          const infoRow = (label, value) => h('div', { key: label }, h('dt', null, label), h('dd', null, value));
          const counterRow = (label, value) => h('tr', { key: label }, h('th', { scope: 'row' }, label), h('td', null, value));
          return h('section', { className: 'sm-manager-section', 'aria-label': '记忆运行状态' },
            error ? h('p', { className: 'sm-runtime-error', role: 'alert' }, `状态读取失败：${error}`) : null,
            state ? h(React.Fragment, null,
              h('dl', { className: 'sm-runtime-info' },
                infoRow('运行状态', sleeping || state.sleeping ? '正在整理记忆' : '空闲'),
                infoRow('配置回退范围', state.projectId ?? '全局'),
                infoRow('上次成功整理', formatRuntimeTime(state.schedule?.lastSuccessAt)),
                infoRow('下次定时整理', state.nextSleepAt ? formatRuntimeTime(state.nextSleepAt) : '未启用')),
              state.schedule?.lastError ? h('p', { className: 'sm-runtime-error', role: 'alert' },
                `调度失败：${state.schedule.lastError} · 连续失败 ${state.schedule.failures} 次`) : null,
              state.lastSleepError ? h('p', { className: 'sm-runtime-error', role: 'alert' }, `最近整理失败：${state.lastSleepError.message}`) : null,
              h('div', { className: 'sm-runtime-counts' },
                h('h3', null, '本次加载'),
                h('p', { className: 'sm-runtime-note' }, hasActivity ? '以下计数仅统计本次加载。' : '本次加载暂无运行记录。'),
                h('p', { className: 'sm-runtime-note' }, '计数在插件重新加载后重置，上次成功整理时间单独持久保存。'),
                h('details', null,
                  h('summary', null, '诊断计数'),
                  h('table', { className: 'sm-runtime-counters', 'aria-label': '本次加载诊断计数' },
                    h('tbody', null,
                      counterRow('情绪评分', `已尝试 ${state.scoring?.attempted ?? 0} 次，写入 ${state.scoring?.stored ?? 0} 条，跳过 ${state.scoring?.skipped ?? 0} 次，失败 ${state.scoring?.failed ?? 0} 次`),
                      counterRow('查询扩展', `成功 ${state.expansion?.succeeded ?? 0} 次，失败或不可用 ${state.expansion?.failed ?? 0} 次`),
                      counterRow('自动注入', `注入 ${state.injection?.injected ?? 0} 条，重复跳过 ${state.injection?.duplicateSkipped ?? 0} 次，预算跳过 ${state.injection?.budgetSkipped ?? 0} 次`))))))
              : !error ? h('p', { className: 'sm-runtime-note', role: 'status' }, '正在读取运行状态…') : null);
        }

        /** 管理与原文共用居中弹窗，浏览器负责焦点约束与关闭后的焦点恢复。 */
        function MemoryDialog({ id, title, open, onClose, children }) {
          const dialogRef = useRef(null);
          useEffect(() => {
            const dialog = dialogRef.current;
            if (open && !dialog.open) dialog.showModal();
            else if (!open && dialog.open) dialog.close();
          }, [open]);
          useEffect(() => {
            const dialog = dialogRef.current;
            return () => { if (dialog.open) dialog.close(); };
          }, []);
          return h('dialog', {
            ref: dialogRef, id, className: 'sm-dialog', 'aria-labelledby': `${id}-title`, onClose,
            onCancel: (event) => { event.preventDefault(); onClose(); },
            onClick: (event) => {
              if (event.target !== event.currentTarget) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              // 只响应弹窗外的遮罩点击，保留表单内部留白的点击行为。
              if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
            },
          },
          h('div', { className: 'sm-dialog-head' },
            h('h2', { id: `${id}-title`, className: 'sm-dialog-title' }, title),
            h('button', { type: 'button', className: 'sm-btn sm-btn-quiet', onClick: onClose, autoFocus: true, 'aria-label': `关闭${title}` }, '关闭')),
          h('div', { className: 'sm-dialog-body' }, children));
        }

        function MemoryBankPage() {
          useLocale();
          const toast = useToast();
          const [stats, reloadStats] = useStats();
          const [view, setView] = useState('browse');
          const [managementView, setManagementView] = useState(null);

          // Browse state: layer filter, debounced query, one accumulating page.
          const [layer, setLayer] = useState('all');
          const [validity, setValidity] = useState('active');
          const [projectFilter, setProjectFilter] = useState('');
          const [globalOnly, setGlobalOnly] = useState(false);
          const [grouped, setGrouped] = useState(false);
          const [groups, setGroups] = useState([]);
          const [queryInput, setQueryInput] = useState('');
          const [query, setQuery] = useState('');
          const [items, setItems] = useState(null);
          const [total, setTotal] = useState(0);
          const [page, setPage] = useState(0);
          const [loading, setLoading] = useState(false);
          const queryTimer = useRef(null);
          const listRequest = useRef(0);

          // Edges load lazily when the tab opens.
          const [edgesList, reloadEdges] = useEdges(view === 'edges');

          // Sleep cycle state: which action is in flight, the last report banner.
          const [sleeping, setSleeping] = useState(false);
          const [previewing, setPreviewing] = useState(false);
          const [report, setReport] = useState(null);
          const runtime = useRuntimeStatus(sleeping);
          const groupResults = grouped || Boolean(projectFilter && !globalOnly);
          const projects = stats?.projects ?? [];
          const projectName = (projectId) => projectId === null
            ? (projectFilter && !globalOnly ? '全局公共记忆' : '全局记忆')
            : projects.find((project) => project.projectId === projectId)?.title ?? projectId;

          useEffect(() => {
            if (queryTimer.current) clearTimeout(queryTimer.current);
            queryTimer.current = setTimeout(() => setQuery(queryInput.trim()), 300);
            return () => { if (queryTimer.current) clearTimeout(queryTimer.current); };
          }, [queryInput]);

          const loadPage = useCallback(async (targetPage, append) => {
            const request = ++listRequest.current;
            setLoading(true);
            try {
              const outcome = await call('list', {
                layer: layer === 'all' ? undefined : layer,
                query: query === '' ? undefined : query,
                limit: PAGE_SIZE,
                offset: targetPage * PAGE_SIZE,
                state: validity,
                ...(globalOnly ? { projectId: null } : projectFilter ? { projectId: projectFilter, includeGlobal: true } : {}),
                ...(groupResults ? { groupBy: 'project' } : {}),
              });
              if (request !== listRequest.current) return;
              const next = Array.isArray(outcome?.items) ? outcome.items : [];
              setTotal(outcome?.total ?? 0);
              setGroups(Array.isArray(outcome?.groups) ? outcome.groups : []);
              setItems((prev) => (append && Array.isArray(prev) ? [...prev, ...next] : next));
              setPage(targetPage);
            } catch (error) {
              if (request !== listRequest.current) return;
              if (!append) { setItems([]); setTotal(0); setGroups([]); }
              showToast(`${t('sleep-memory.toast.failed')}：${error?.message ?? error}`, true);
            } finally {
              if (request === listRequest.current) setLoading(false);
            }
          }, [layer, query, validity, projectFilter, globalOnly, groupResults, t]);

          useEffect(() => {
            setItems(null);
            setGroups([]);
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
          const filterActive = layer !== 'all' || query !== '' || validity !== 'active' || projectFilter !== '' || globalOnly;
          const onRecordsChanged = () => { void loadPage(0, false); reloadStats(); reloadEdges(); };
          const renderRows = (records, hideProject = false) => h('ul', { className: 'sm-rows' },
            records.map((item) => h(RecordRow, {
              item, key: item.id, projectTitle: projectName(item.projectId ?? null), hideProject, onChanged: onRecordsChanged,
            })));

          let browseBody;
          if (items === null && loading) {
            browseBody = SkeletonRows({ count: 5, label: t('sleep-memory.state.loading') });
          } else if (total === 0 && !filterActive) {
            browseBody = EmptyState({ title: t('sleep-memory.empty.title'), hint: t('sleep-memory.empty.hint') });
          } else if (items !== null && items.length === 0) {
            browseBody = EmptyState({
              title: t('sleep-memory.empty.filtered.title'),
              actionLabel: t('sleep-memory.empty.filtered.action'),
              onAction: () => { setQueryInput(''); setQuery(''); setLayer('all'); setValidity('active'); setProjectFilter(''); setGlobalOnly(false); },
            });
          } else {
            const loadedGroups = new Map();
            for (const item of items ?? []) {
              const projectId = item.projectId ?? null;
              if (!loadedGroups.has(projectId)) loadedGroups.set(projectId, []);
              loadedGroups.get(projectId).push(item);
            }
            const groupTotals = new Map(groups.map((group) => [group.projectId, group.total]));
            browseBody = h(React.Fragment, null,
              groupResults ? h('div', { 'aria-label': '按项目分组的记忆' },
                [...loadedGroups].map(([projectId, records]) => h('details', {
                  className: 'sm-project-group', key: JSON.stringify(projectId), open: true,
                },
                h('summary', null, projectName(projectId),
                  h('span', { className: 'sm-count' }, `${groupTotals.get(projectId) ?? records.length} 条`),
                  (groupTotals.get(projectId) ?? 0) > records.length
                    ? h('span', { className: 'sm-count' }, `已加载 ${records.length} 条`) : null),
                renderRows(records, true)))) : renderRows(items ?? []),
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
                h('h1', { className: 'sm-title' }, t('sleep-memory.page.title')),
                h('button', { type: 'button', className: 'sm-btn sm-btn-quiet', onClick: () => setManagementView('status') }, '管理')),

              h(StatsCard, { stats, onRefresh: onRecordsChanged }),
              h(RuntimeSummary, { ...runtime, sleeping, onOpen: () => setManagementView('status') }),

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
                  h('h2', { className: 'sm-listtitle' }, '筛选结果'),
                  h('span', { className: 'sm-count' }, t('sleep-memory.browse.count', { n: total })),
                  hasMore ? h('span', { className: 'sm-count' }, `已加载 ${items.length} 条`) : null,
                  h('span', { className: 'sm-spring' }),
                  !projectFilter && !globalOnly ? h('label', { className: 'sm-group-toggle' },
                    h('input', { type: 'checkbox', checked: grouped, onChange: (event) => setGrouped(event.target.checked) }), '按项目分组')
                    : projectFilter && !globalOnly ? h('span', { className: 'sm-count' }, '包含全局公共记忆') : null),
                h('div', { className: 'sm-toolbar' },
                  h('div', { className: 'sm-toolbar-grow' },
                    h('input', {
                      className: 'sm-search', type: 'search', value: queryInput,
                      placeholder: t('sleep-memory.search'), 'aria-label': t('sleep-memory.search.aria'),
                      onChange: (event) => setQueryInput(event.target.value),
                    })),
                  h('label', { className: 'sm-visually-hidden', htmlFor: 'sm-layer' }, t('sleep-memory.filter.label')),
                  h('select', { className: 'sm-select', value: validity, 'aria-label': '有效性筛选', onChange: (event) => setValidity(event.target.value) },
                    ...Object.entries(STATE_LABELS).map(([key, label]) => h('option', { key, value: key }, label)),
                    h('option', { value: 'all' }, '全部历史')),
                  h(ProjectPicker, { projects, projectId: projectFilter, globalOnly,
                    onChange: (selection) => { setProjectFilter(selection.projectId); setGlobalOnly(selection.globalOnly); } }),
                  h('select', {
                    id: 'sm-layer', className: 'sm-select', value: layer,
                    'aria-label': t('sleep-memory.filter.label'),
                    onChange: (event) => setLayer(event.target.value),
                  },
                  h('option', { value: 'all' }, t('sleep-memory.filter.all')),
                  LAYERS.map((name) => h('option', { key: name, value: name }, t(`sleep-memory.layer.${name}`))))),
                stats?.projectError ? h('p', { className: 'sm-runtime-note', role: 'status' }, stats.projectError) : null,
                browseBody) : null,

              view === 'scatter' ? h('div', { className: 'sm-listhead' },
                h('h2', { className: 'sm-listtitle' }, t('sleep-memory.scatter.title')),
                h('span', { className: 'sm-count' }, t('sleep-memory.scatter.count', { n: (items ?? []).filter((item) => item.layer === 'salient').length }))) : null,
              view === 'scatter' && items !== null ? h(ScatterView, { items }) : null,

              view === 'edges' ? h('div', { className: 'sm-listhead' },
                h('h2', { className: 'sm-listtitle' }, t('sleep-memory.edges.title')),
                h('span', { className: 'sm-count' }, edgesList === null ? '' : t('sleep-memory.edges.count', { n: edgesList.length }))) : null,
              view === 'edges' ? h(EdgesView, { edges: edgesList }) : null,

              h(MemoryDialog, { id: 'sm-manager', title: '记忆管理', open: managementView !== null, onClose: () => setManagementView(null) },
                h('div', { className: 'sm-manager-tabs', role: 'group', 'aria-label': '记忆管理分类' },
                  [['status', '运行详情'], ['scope', '会话范围'], ['backup', '备份恢复']].map(([key, label]) =>
                    h('button', { key, type: 'button', className: 'sm-btn sm-btn-quiet', 'aria-pressed': managementView === key,
                      'aria-controls': `sm-manager-${key}`, onClick: () => setManagementView(key) }, label))),
                h('div', { id: 'sm-manager-status', hidden: managementView !== 'status' }, h(RuntimeStatus, { ...runtime, sleeping })),
                h('div', { id: 'sm-manager-scope', hidden: managementView !== 'scope' }, h(ScopePanel)),
                h('div', { id: 'sm-manager-backup', hidden: managementView !== 'backup' },
                  h(BackupPanel, { onChanged: () => { void loadPage(0, false); reloadStats(); reloadEdges(); } }))),
              h(Toast, { toast })));
        }

        // ---- bundle detail page inline config (plugins.bundle.config) --------

        const CONFIG_FIELD_ORDER = ['injectEnabled', 'recallBudget', 'injectBudget', 'sleepIntervalMinutes', 'salientScoringEnabled', 'sleepOnStart', 'projectId',
          'injectMaxTotalChars', 'injectRepeatAfterTurns', 'salientDecayHalfLifeDays', 'salientReviewAfterDays'];

        /** Initial free-typing drafts: booleans stay booleans, numbers become raw strings. */
        function configDraftFrom(fields) {
          const draft = {};
          for (const key of CONFIG_FIELD_ORDER) {
            const field = fields[key];
            if (!field) continue;
            draft[key] = field.type === 'boolean'
              ? field.value === true
              : (field.type === 'string' ? String(field.value ?? '') : (typeof field.value === 'number' && Number.isFinite(field.value) ? String(field.value) : ''));
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
            } else if (field.type === 'string') {
              parsed[key] = String(draft[key] ?? '');
              if (parsed[key].length > 200 || parsed[key] !== parsed[key].trim()) valid = false;
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
          for (const [key, label, hint] of [
            ['salientScoringEnabled', '自动情绪评分', '模型推断会单独标记；关闭不影响已有记忆'],
            ['sleepOnStart', '加载时按期补跑', '首次或超过睡眠间隔时补跑；未到期不重复执行'],
          ]) {
            if (!fields[key]) continue;
            rows.push(h('label', { className: 'sm-config-row', key },
              h('span', { className: 'sm-config-label' }, label),
              h('input', { type: 'checkbox', disabled: busy, checked: parsed[key] === true, onChange: () => setBoolean(key) }),
              h('span', { className: 'sm-config-hint' }, hint),
              fields[key].overridden ? resetButton(key) : null));
          }
          if (fields.projectId) rows.push(h('label', { className: 'sm-config-row', key: 'projectId' },
            h('span', { className: 'sm-config-label' }, '配置回退项目范围'),
            h('input', {
              type: 'text', className: 'sm-search', maxLength: 200, disabled: busy,
              value: String(draft.projectId ?? ''), onChange: (event) => setNumber('projectId', event.target.value),
            }),
            h('span', { className: 'sm-config-hint' }, '无会话绑定或工作区时使用；空值表示全局'),
            fields.projectId.overridden ? resetButton('projectId') : null));
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
          for (const [key, label, hint] of [
            ['injectMaxTotalChars', '注入总字符预算', '包含标题、来源和关联内容，超过预算的条目不注入'],
            ['injectRepeatAfterTurns', '重复注入间隔', '相同会话与范围内间隔多少轮允许再次注入，0 为关闭去重'],
            ['salientDecayHalfLifeDays', '显著经历衰减半衰期', '单位为天，0 为关闭；建议长于普通记忆'],
            ['salientReviewAfterDays', '显著经历复核期限', '单位为天，0 为关闭；到期后在睡眠时转为待复核'],
          ]) {
            const field = fields[key];
            if (!field) continue;
            rows.push(h('label', { className: 'sm-config-row', key },
              h('span', { className: 'sm-config-label' }, label),
              h('input', {
                type: 'number', className: 'sm-search sm-config-num', min: field.min, max: field.max, step: 1,
                value: String(draft[key] ?? ''), disabled: busy, 'aria-label': label,
                onChange: (event) => setNumber(key, event.target.value),
              }),
              h('span', { className: 'sm-config-hint' }, hint),
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

          for (const packageId of CONFIG_PACKAGE_IDS) {
            const bundleConfig = bind('bundleConfig', 'plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config', key: packageId, locale: NS,
            }, BundleConfigSection));
            if (typeof bundleConfig === 'function') disposers.push(bundleConfig);
            const rowConfig = bind('rowConfig', 'plugins.row.config', () => ctx.slots.register({
              name: 'plugins.row.config', key: `${packageId}#${SLOT_ID}`, locale: NS,
            }, BundleConfigSection));
            if (typeof rowConfig === 'function') disposers.push(rowConfig);
          }

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
