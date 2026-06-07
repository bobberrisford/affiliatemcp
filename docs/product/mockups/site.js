/* Shared nav + footer for the affiliate-mcp site mockups.
   Each page sets <body data-page="..."> to highlight the active nav link. */
(function () {
  var MARK =
    '<svg viewBox="0 0 120 120" role="img" aria-label="affiliate-mcp mark">' +
    '<rect x="0" y="0" width="120" height="120" rx="14" fill="#2B2BFF"></rect>' +
    '<polyline points="34,38 58,60 34,82" fill="none" stroke="#fff" stroke-width="13" stroke-linecap="square" stroke-linejoin="miter"></polyline>' +
    '<rect x="66" y="68" width="24" height="14" fill="#fff"></rect></svg>';

  var LINKS = [
    { id: "how", label: "how it works", href: "index.html#how" },
    { id: "networks", label: "networks", href: "networks.html" },
    { id: "adopt", label: "adopt your adapter", href: "adopt.html" },
    { id: "ask", label: "what you can ask", href: "what-you-can-ask.html" },
    { id: "mission", label: "mission", href: "mission.html" },
  ];

  function renderNav() {
    var page = document.body.getAttribute("data-page") || "";
    var links = LINKS.map(function (l) {
      return '<a class="' + (l.id === page ? "on" : "") + '" href="' + l.href + '">' + l.label + "</a>";
    }).join("");
    return (
      '<nav class="nav"><div class="wrap">' +
      '<a class="brand" href="index.html">' + MARK +
      '<span class="wm">affiliate<span class="mcp">mcp</span></span></a>' +
      '<div class="links">' + links + "</div>" +
      '<div class="right">' +
      '<a class="btn d sm" href="https://github.com/bobberrisford/affiliatemcp">★ github</a>' +
      '<a class="btn p sm" href="get-started.html">npx setup ▸</a>' +
      "</div></div></nav>"
    );
  }

  function renderFooter() {
    return (
      '<footer class="foot"><div class="wrap">' +
      '<div class="big">affiliate<span class="mcp">mcp</span></div>' +
      '<div class="stamps">' +
      '<span class="chip acid">FREE &amp; OPEN</span><span class="chip">MIT LICENCE</span>' +
      '<span class="chip">LOCAL-FIRST</span><span class="chip mag">NO TELEMETRY</span>' +
      '<span class="chip">UK ENGLISH</span></div>' +
      '<div class="rows"><div class="cols">' +
      '<a href="get-started.html">get started</a><a href="networks.html">networks</a>' +
      '<a href="adopt.html">adopt your adapter</a><a href="mission.html">manifesto</a>' +
      '<a href="https://github.com/bobberrisford/affiliatemcp">github</a></div>' +
      '<div style="font-family:var(--font-mono);font-size:0.74rem;color:var(--fg-invert-mut)">built from the open-source repo · free · open · yours</div>' +
      "</div></div></footer>"
    );
  }

  document.addEventListener("DOMContentLoaded", function () {
    var n = document.getElementById("site-nav");
    if (n) n.outerHTML = renderNav();
    var f = document.getElementById("site-footer");
    if (f) f.outerHTML = renderFooter();
  });
})();
