(function() {
  var THEME_IDS = ["cobalt-mass", "porcelain-cobalt"];
  var PRE_CSS_CHROME = { "porcelain-cobalt": "#f4f6fa", "cobalt-mass": "#1c2f7e" };
  var KEY = "hyperfaucet-appearance";
  var meta = document.createElement("meta");
  meta.name = "theme-color";

  var state = { theme: "cobalt-mass" };
  try {
    var raw = localStorage.getItem(KEY);
    if(raw) {
      var parsed = JSON.parse(raw);
      if(THEME_IDS.indexOf(parsed.theme) !== -1) state.theme = parsed.theme;
    } else {
      var legacy = localStorage.getItem("hyperfaucet-theme");
      if(THEME_IDS.indexOf(legacy) !== -1) state.theme = legacy;
    }
  } catch(e) {}

  function resolveTheme() { return state.theme; }
  function updateChrome(theme) {
    var chrome = "";
    try { chrome = getComputedStyle(document.documentElement).getPropertyValue("--chrome").trim(); } catch(e) {}
    meta.content = chrome || PRE_CSS_CHROME[theme] || PRE_CSS_CHROME["cobalt-mass"];
  }
  function apply() {
    var theme = resolveTheme();
    document.documentElement.setAttribute("data-theme", theme);
    if(document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", function() { requestAnimationFrame(function() { updateChrome(theme); }); }, { once: true });
    else
      requestAnimationFrame(function() { updateChrome(theme); });
  }

  window.__getFaucetAppearance = function() { return { theme: state.theme, mascot: "miner" }; };
  window.__setFaucetAppearance = function(patch) {
    if(patch && THEME_IDS.indexOf(patch.theme) !== -1) state.theme = patch.theme;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e) {}
    apply();
    try { window.dispatchEvent(new CustomEvent("faucet-appearance-change")); } catch(e) {}
    return window.__getFaucetAppearance();
  };
  apply();
  document.head.appendChild(meta);
})();
