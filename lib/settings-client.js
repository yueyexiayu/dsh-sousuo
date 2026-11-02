window.__ModuleLoader__.load({
  id: "sousuo",
  factory: function (require) {
    var React = require("react"), h = React.createElement;
    async function request(options) {
      var response = await fetch("/api/sousuo/settings", options), body;
      try { body = await response.json(); } catch (_) { throw new Error("无法读取数据（HTTP " + response.status + "）"); }
      if (!response.ok || !body || body.ok !== true) {
        var error = new Error(body && body.error ? String(body.error) : "请求失败（HTTP " + response.status + "）");
        error.status = response.status; throw error;
      }
      return body;
    }
    function Settings() {
      var d = React.useState(null), draft = d[0], setDraft = d[1];
      var s = React.useState(null), saved = s[0], setSaved = s[1];
      var r = React.useState(null), revision = r[0], setRevision = r[1];
      var p = React.useState(false), pending = p[0], setPending = p[1];
      var e = React.useState(""), error = e[0], setError = e[1];
      var m = React.useState(""), message = m[0], setMessage = m[1];
      var c = React.useState(false), conflict = c[0], setConflict = c[1];
      var host = React.useState(null), hostConfig = host[0], setHostConfig = host[1];
      React.useEffect(function () {
        var controller = new AbortController();
        request({ signal: controller.signal, cache: "no-store" }).then(function (body) {
          if (!controller.signal.aborted) { setDraft(body.settings); setSaved(body.settings); setRevision(body.revision); setHostConfig(body.hostConfig || null); }
        }).catch(function (err) { if (!controller.signal.aborted) setError(err.message); });
        return function () { controller.abort(); };
      }, []);
      async function reload() {
        if (pending) return;
        setPending(true); setError(""); setMessage("");
        try { var body = await request({ cache: "no-store" }); setDraft(body.settings); setSaved(body.settings); setRevision(body.revision); setHostConfig(body.hostConfig || null); setConflict(false); }
        catch (err) { setError(err.message); } finally { setPending(false); }
      }
      function edit(key, value) { setDraft(function (current) { return Object.assign({}, current, { [key]: value }); }); setError(""); setMessage(""); }
      async function save(event) {
        event.preventDefault(); if (!draft || pending || conflict) return;
        var count = draft.maxResults;
        if (count !== null && (!Number.isInteger(count) || count < 1 || count > 20)) { setError("默认结果数量必须是 1–20 的整数，或留空使用自动值。"); return; }
        setPending(true); setError(""); setMessage("");
        try {
          var body = await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: draft, revision: revision }) });
          setDraft(body.settings); setSaved(body.settings); setRevision(body.revision); setMessage("默认设置已保存。");
        } catch (err) { if (err.status === 409) { setConflict(true); setError("设置已在其他位置更改。请重新加载后再保存；重新加载会丢弃当前更改。"); } else setError(err.message); }
        finally { setPending(false); }
      }
      var dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
      return h("section", { className: "sousuo-settings", "aria-label": "搜索默认设置" },
        h("style", null, ".sousuo-settings{margin:16px 0;font:inherit;color:inherit}.sousuo-settings h3{font-size:14px;margin:0 0 8px}.sousuo-settings p{margin:8px 0}.sousuo-settings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0}.sousuo-settings-field{display:flex;flex-direction:column;gap:6px}.sousuo-settings select,.sousuo-settings input{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#f8f9fb);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:8px;padding:7px 9px}.sousuo-settings button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#f8f9fb);border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:8px;padding:6px 12px;cursor:pointer}.sousuo-settings button:disabled{opacity:.5;cursor:default}.sousuo-settings-error{color:var(--dsw-alias-danger-fg,#c23b3b)}.sousuo-settings-note{color:var(--dsw-alias-label-secondary,#757b85)}"),
        h("h3", null, "搜索默认设置"),
        h("p", { className: "sousuo-settings-note" }, "设置搜索请求的默认参数；调用时明确指定的参数优先。留空使用自动值。默认结果数量是请求数量，原生 web_search 最终展示数量还可能受官方结果渲染限制。"),
        h("h3", null, "当前 Host 配置（只读）"),
        h("p", { className: "sousuo-settings-note" }, "以下是 Host 启动时实际使用的配置，来自 profile／Host 配置及其默认值；修改配置后需重启。密钥内容不会显示。"),
        hostConfig ? h("dl", null,
          h("dt", null, "baseURL"), h("dd", null, hostConfig.baseURL == null ? "不可用" : String(hostConfig.baseURL)),
          h("dt", null, "keysPath"), h("dd", null, hostConfig.keysPath == null ? "不可用" : String(hostConfig.keysPath)),
          h("dt", null, "maxRenderedContentChars"), h("dd", null, hostConfig.maxRenderedContentChars == null ? "不可用" : String(hostConfig.maxRenderedContentChars)),
          h("dt", null, "advancedTools"), h("dd", null, typeof hostConfig.advancedTools === "boolean" ? (hostConfig.advancedTools ? "启用" : "关闭") : "不可用")) : h("p", { className: "sousuo-settings-note" }, "Host 配置不可用。"),
        error ? h("p", { role: "alert", className: "sousuo-settings-error" }, error) : null,
        message ? h("p", { role: "status" }, message) : null,
        !draft ? (!error ? h("p", { role: "status" }, "正在加载设置…") : h("button", { type: "button", disabled: pending, onClick: reload }, "重新加载设置")) : h("form", { onSubmit: save },
          h("div", { className: "sousuo-settings-grid" },
            h("label", { className: "sousuo-settings-field" }, "默认结果数量（1–20）", h("input", { type: "number", min: 1, max: 20, step: 1, value: draft.maxResults === null ? "" : draft.maxResults, placeholder: "自动", disabled: pending, onChange: function (event) { edit("maxResults", event.target.value === "" ? null : Number(event.target.value)); } })),
            h("label", { className: "sousuo-settings-field" }, "默认区域", h("select", { value: draft.zone, disabled: pending, onChange: function (event) { edit("zone", event.target.value); } }, h("option", { value: "auto" }, "自动"), h("option", { value: "cn" }, "中国"), h("option", { value: "intl" }, "国际"))),
            h("label", { className: "sousuo-settings-field" }, "默认语言", h("input", { type: "text", maxLength: 35, value: draft.language, placeholder: "自动，例如 zh-CN", disabled: pending, onChange: function (event) { edit("language", event.target.value); } }))),
          h("button", { type: "submit", disabled: pending || !dirty || conflict }, pending ? "处理中…" : "保存设置"), " ",
          h("button", { type: "button", disabled: pending || !dirty, onClick: function () { setDraft(saved); setError(""); setMessage(""); } }, "撤销更改"),
          conflict ? h("button", { type: "button", disabled: pending, onClick: reload }, "重新加载设置") : null));
    }
    function apply(ctx) { ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register({ name: "plugins.bundle.config", key: "sousuo" }, Settings); }); }
    return { inject: ["slots"], apply: apply };
  }
});
