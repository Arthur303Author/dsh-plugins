window.__ModuleLoader__.load({
  id: "dsh-enhance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const CSS = `
      * {
        --dsh-chat-content-width: 94% !important;
      }
      [data-chat-flow] {
        gap: 8px !important;
      }
      [data-slot="conversation.input.dock"] > div {
        max-width: var(--dsh-chat-content-width) !important;
      }
      [data-slot="conversation.composer.dock"] {
        display: flex !important;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      [data-slot="conversation.composer.dock"] > div:first-child {
        flex: 1 1 auto;
        min-width: 0;
        width: auto !important;
      }
      .dsh-balance-cell{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;padding-top:4px}
      .dsh-balance-cell .dsh-balance-val{cursor:pointer;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-decoration:none}
      .dsh-balance-cell .dsh-balance-val:hover{color:var(--dsw-alias-brand-primary)}
      .dsh-balance-chart{width:15px;height:15px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;padding:0}
      .dsh-balance-chart:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-balance-err{color:var(--dsw-alias-state-warn-primary);cursor:pointer}
      .dsh-usage-backdrop{position:fixed;inset:0;z-index:1000;background:color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent);display:flex;align-items:center;justify-content:center}
      .dsh-usage-panel{width:min(760px,92vw);max-height:84vh;overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:var(--dsw-shadow-lv3);padding:16px 20px;color:var(--dsw-alias-label-primary)}
      .dsh-usage-header{display:flex;align-items:center;gap:12px;margin-bottom:4px}
      .dsh-usage-title{font-size:15px;font-weight:600;flex:1;margin:0}
      .dsh-usage-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0 0 10px}
      .dsh-usage-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
      .dsh-usage-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-usage-summary{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
      .dsh-usage-summary b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
      .dsh-usage-legend{display:flex;gap:14px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:10px}
      .dsh-usage-dot{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:4px;vertical-align:middle}
      .dsh-usage-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:24px 0;text-align:center}
      .dsh-chart-cache{fill:var(--dsw-alias-state-success-primary)}
      .dsh-chart-input{fill:var(--dsw-alias-brand-primary)}
      .dsh-chart-output{fill:#a78bfa}
      .dsh-usage-axis{fill:var(--dsw-alias-label-tertiary);font-size:9px}
    `;

    function api(path) {
      return fetch("/enh/" + path).then((r) => r.json());
    }

    function fmt(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "K";
      return String(n);
    }
    function fmtCost(c) {
      const v = Number(c);
      if (!Number.isFinite(v) || v < 0) return "¥0";
      return v >= 1 ? "¥" + v.toFixed(2) : "¥" + v.toFixed(4);
    }

    function Bars({ steps, W, H, dense }) {
      const PAD = 4, BASE = H - 4;
      const maxV = Math.max(1, ...steps.map((s) => (s.input + s.output + s.cacheRead)));
      const bw = (W - PAD * 2) / steps.length;
      const segs = [];
      steps.forEach((s, i) => {
        const x = PAD + i * bw;
        const hCache = s.cacheRead / maxV * (BASE - 14);
        const hIn = s.input / maxV * (BASE - 14);
        const hOut = s.output / maxV * (BASE - 14);
        const tip = (dense ? ("第 " + s.idx + " 次请求" + (s.time ? " · " + new Date(s.time).toLocaleTimeString() : "")) : s.date) + " · 缓存 " + fmt(s.cacheRead) + " · 输入 " + fmt(s.input) + " · 输出 " + fmt(s.output) + " · 成本 " + fmtCost(s.cost);
        segs.push(React.createElement("g", { key: i },
          React.createElement("title", null, tip),
          hCache > 0 && React.createElement("rect", { x: x + 1, y: BASE - hCache, width: Math.max(1, bw - 2), height: hCache, rx: 1, className: "dsh-chart-cache" }),
          hIn > 0 && React.createElement("rect", { x: x + 1, y: BASE - hCache - hIn, width: Math.max(1, bw - 2), height: hIn, rx: 1, className: "dsh-chart-input" }),
          hOut > 0 && React.createElement("rect", { x: x + 1, y: BASE - hCache - hIn - hOut, width: Math.max(1, bw - 2), height: hOut, rx: 1, className: "dsh-chart-output" }),
          (dense ? (i % 10 === 0 || i === steps.length - 1) : (i % 5 === 0 || i === steps.length - 1)) && React.createElement("text", { x: x + bw / 2, y: H, textAnchor: "middle", className: "dsh-usage-axis" }, dense ? s.idx : s.date)));
      });
      return React.createElement("svg", { width: "100%", viewBox: "0 0 " + W + " " + H, role: "img" }, segs);
    }

    function UsageOverlay() {
      const [open, setOpenLocal] = React.useState(false);
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const listeners = React.useRef(null);
      if (listeners.current === null) listeners.current = { set: new Set(), setOpen(v) { this.set.forEach((fn) => fn(v)); } };
      React.useEffect(() => {
        const fn = (v) => setOpenLocal(v);
        listeners.current.set.add(fn);
        return () => { listeners.current.set.delete(fn); };
      }, []);
      const load = () => {
        setLoading(true);
        api("usage").then((r) => { setData(r); setLoading(false); }).catch(() => { setData({ error: "查询失败" }); setLoading(false); });
      };
      React.useEffect(() => { if (open && data === null && !loading) load(); }, [open]);
      if (!open) return null;
      const total = (data && !data.error && data.total) ? data.total : null;
      return React.createElement("div", { className: "dsh-usage-backdrop", onClick: () => listeners.current.setOpen(false) },
        React.createElement("div", { className: "dsh-usage-panel", onClick: (e) => e.stopPropagation() },
          React.createElement("div", { className: "dsh-usage-header" },
            React.createElement("h3", { className: "dsh-usage-title" }, "用量统计 · 近 30 天"),
            React.createElement("button", { className: "dsh-usage-btn", onClick: load, disabled: loading }, loading ? "查询中…" : "刷新"),
            React.createElement("a", { className: "dsh-usage-btn", href: "https://platform.deepseek.com/usage", target: "_blank", rel: "noreferrer" }, "查看官方页面 ↗"),
            React.createElement("button", { className: "dsh-usage-btn", onClick: () => listeners.current.setOpen(false) }, "关闭")),
          React.createElement("p", { className: "dsh-usage-sub" }, "数据来源:DSH 本地会话日志(最近 " + (data && !data.error ? data.sessionsScanned : "?") + " 个会话,含子代理)· 成本按每次请求的模型与时间自动计价(8/17 起官方峰谷价,北京时间 9-12、14-18 高峰,空闲半价)"),
          data === null && React.createElement("div", { className: "dsh-usage-empty" }, "加载中…"),
          data !== null && data.error && React.createElement("div", { className: "dsh-usage-empty" }, data.error),
          data !== null && !data.error && React.createElement("div", null,
            React.createElement("div", { className: "dsh-usage-summary" },
              React.createElement("span", null, "请求 ", React.createElement("b", null, fmt(data.requests)), " 次"),
              React.createElement("span", null, "输入 ", React.createElement("b", null, fmt(total.input)), " tok"),
              React.createElement("span", null, "缓存读取 ", React.createElement("b", null, fmt(total.cacheRead)), " tok"),
              React.createElement("span", null, "输出 ", React.createElement("b", null, fmt(total.output)), " tok"),
              React.createElement("span", null, "总成本 ", React.createElement("b", null, fmtCost(data.totalCost)))),
            data.days.length > 0 && React.createElement(Bars, { steps: data.days, W: 640, H: 180, dense: false }),
            data.days.length === 0 && React.createElement("div", { className: "dsh-usage-empty" }, "近 30 天没有会话用量记录"),
            React.createElement("div", { className: "dsh-usage-legend" },
              React.createElement("span", null, React.createElement("span", { className: "dsh-usage-dot", style: { background: "var(--dsw-alias-state-success-primary)" } }), "缓存读取"),
              React.createElement("span", null, React.createElement("span", { className: "dsh-usage-dot", style: { background: "var(--dsw-alias-brand-primary)" } }), "输入(非缓存)"),
              React.createElement("span", null, React.createElement("span", { className: "dsh-usage-dot", style: { background: "#a78bfa" } }), "输出")))));
    }

    function SessionOverlay() {
      const [open, setOpenLocal] = React.useState(false);
      const [fold, setFold] = React.useState({ input: 0, cacheRead: 0, output: 0, cost: 0, requests: 0, steps: [] });
      const listeners = React.useRef(null);
      if (listeners.current === null) listeners.current = { set: new Set(), setOpen(v) { this.set.forEach((fn) => fn(v)); }, open(f) { this.fold = f; } };
      React.useEffect(() => {
        const fn = (v) => setOpenLocal(v);
        listeners.current.set.add(fn);
        return () => { listeners.current.set.delete(fn); };
      }, []);
      if (!open) return null;
      const d = fold;
      return React.createElement("div", { className: "dsh-usage-backdrop", onClick: () => listeners.current.setOpen(false) },
        React.createElement("div", { className: "dsh-usage-panel", onClick: (e) => e.stopPropagation() },
          React.createElement("div", { className: "dsh-usage-header" },
            React.createElement("h3", { className: "dsh-usage-title" }, "本轮用量 · " + d.requests + " 次请求"),
            React.createElement("button", { className: "dsh-usage-btn", onClick: () => listeners.current.setOpen(false) }, "关闭")),
          React.createElement("p", { className: "dsh-usage-sub" }, "数据来源:本会话完整日志(不受界面加载窗口影响)· 成本按每次请求的模型与时间自动计价(官方峰谷价:北京时间 9-12、14-18 高峰,空闲半价;8/17 前为现行价)"),
          React.createElement("div", { className: "dsh-usage-summary" },
            React.createElement("span", null, "输入 ", React.createElement("b", null, fmt(d.input)), " tok"),
            React.createElement("span", null, "缓存读取 ", React.createElement("b", null, fmt(d.cacheRead)), " tok"),
            React.createElement("span", null, "输出 ", React.createElement("b", null, fmt(d.output)), " tok"),
            React.createElement("span", null, "合计 ", React.createElement("b", null, fmtCost(d.cost)))),
          d.steps.length > 0 && React.createElement(Bars, { steps: d.steps, W: 640, H: 150, dense: true }),
          d.steps.length === 0 && React.createElement("div", { className: "dsh-usage-empty" }, "本会话还没有带用量记录的消息"),
          React.createElement("div", { className: "dsh-usage-legend" },
            React.createElement("span", null, React.createElement("span", { className: "dsh-usage-dot", style: { background: "var(--dsw-alias-state-success-primary)" } }), "缓存读取"),
            React.createElement("span", null, React.createElement("span", { className: "dsh-usage-dot", style: { background: "var(--dsw-alias-brand-primary)" } }), "输入(非缓存)"),
            React.createElement("span", null, React.createElement("span", { className: "dsh-usage-dot", style: { background: "#a78bfa" } }), "输出"))));
    }

    function BalanceView() {
      const [state, setState] = React.useState(null);
      const [openOverlay, setOpenOverlay] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          api("balance").then((result) => { if (alive) setState(result); }).catch(() => { if (alive) setState({ error: "查询失败" }); });
        };
        load();
        const timer = setInterval(load, 300000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      if (openOverlay) {
        return React.createElement(UsageOverlay, null);
      }
      if (state === null) {
        return React.createElement("span", { className: "dsh-balance-cell" }, React.createElement("span", null, "余额查询中…"));
      }
      if (state.error) {
        return React.createElement("span", { className: "dsh-balance-cell" }, React.createElement("span", {
          className: "dsh-balance-err",
          title: state.error,
          onClick: () => { api("balance").then(setState).catch(() => {}); },
        }, "余额 " + state.error));
      }
      const currency = state.currency || "CNY";
      const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
      const text = symbol + state.total + (currency !== "CNY" && currency !== "USD" ? " " + currency : "");
      return React.createElement("span", { className: "dsh-balance-cell" },
        React.createElement("span", null, "余额"),
        React.createElement("a", {
          className: "dsh-balance-val",
          href: "https://platform.deepseek.com/usage",
          target: "_blank",
          rel: "noreferrer",
          title: "打开官方页面:充值或查看官方用量(查询于 " + new Date(state.fetchedAt).toLocaleTimeString() + ")",
        }, text),
        React.createElement("button", {
          className: "dsh-balance-chart",
          title: "近 30 天用量图表(DSH 本地统计)",
          onClick: () => setOpenOverlay(true),
        },
          React.createElement("svg", { width: 10, height: 10, viewBox: "0 0 10 10", "aria-hidden": true },
            React.createElement("rect", { x: 1, y: 4, width: 2, height: 5, rx: 0.5, fill: "currentColor" }),
            React.createElement("rect", { x: 4, y: 2, width: 2, height: 7, rx: 0.5, fill: "currentColor" }),
            React.createElement("rect", { x: 7, y: 0.5, width: 2, height: 8.5, rx: 0.5, fill: "currentColor" }))));
    }

    function SessionCostView({ sessionId }) {
      const [data, setData] = React.useState(null);
      const [openOverlay, setOpenOverlay] = React.useState(false);
      React.useEffect(() => {
        if (typeof sessionId !== "string" || sessionId === "") return;
        let alive = true;
        const load = () => {
          api("session-usage?sessionId=" + encodeURIComponent(sessionId)).then((r) => { if (alive) setData(r); }).catch(() => { if (alive) setData({ error: true }); });
        };
        load();
        const timer = setInterval(load, 60000);
        return () => { alive = false; clearInterval(timer); };
      }, [sessionId]);
      const requests = data && !data.error ? data.requests : 0;
      const shown = data === null ? "…" : fmtCost(data && !data.error ? data.cost : undefined);
      return React.createElement("span", { className: "dsh-balance-cell" },
        React.createElement("span", null, "本轮"),
        React.createElement("span", {
          className: "dsh-balance-val",
          title: requests > 0 ? ("本轮 " + requests + " 次请求 · 点击查看图表") : "本会话暂无用量记录",
          onClick: () => {
            if (typeof sessionId !== "string" || sessionId === "") return;
            api("session-usage?sessionId=" + encodeURIComponent(sessionId)).then((r) => {
              if (r && !r.error) { setOpenOverlay(true); }
            }).catch(() => {});
          },
        }, shown),
        openOverlay && React.createElement(SessionOverlay, null));
    }

    function DockCell(props) {
      return React.createElement(React.Fragment, null,
        React.createElement(BalanceView, null),
        React.createElement(SessionCostView, props));
    }

    function apply(ctx) {
      // Every resource this plugin adds registers through ctx.effect, so a fiber
      // dispose (slot collapse, hot reload, plugin unload) removes it. Before
      // this, the <style> was appended unconditionally -- even on the early
      // return below -- and the slot disposers were dropped entirely, so both
      // leaked on every reload.
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-enhance";
        style.dataset.pluginCss = "dsh-enhance";
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      });

      const slots = ctx.get("slots");
      if (slots === undefined) return;
      ctx.effect(() => slots.inject("conversation.composer.dock", () => slots.register(
        { name: "conversation.composer.dock", id: "dsh-enhance-dock", order: 1 },
        (props) => React.createElement(DockCell, props),
      )));
      ctx.effect(() => slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "dsh-enhance-usage", order: 10 },
        () => React.createElement(UsageOverlay),
      )));
      ctx.effect(() => slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "dsh-enhance-session-usage", order: 11 },
        () => React.createElement(SessionOverlay),
      )));
    }

    exports.apply = apply;
    return module.exports;
  },
});
