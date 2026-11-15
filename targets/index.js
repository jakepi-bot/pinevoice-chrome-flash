/* Target registry, mirroring bflb_flash/targets/__init__.py (plus bl606p for PineVoice). */
(function (root, factory) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports;
  const bl602 = isNode ? require("./bl602.js") : root.BflbFlashTargetBL602;
  const bl616 = isNode ? require("./bl616.js") : root.BflbFlashTargetBL616;
  const bl616cl = isNode ? require("./bl616cl.js") : root.BflbFlashTargetBL616CL;
  const bl618dg = isNode ? require("./bl618dg.js") : root.BflbFlashTargetBL618DG;
  const bl606p = isNode ? require("./bl606p.js") : root.BflbFlashTargetBL606P;
  const api = factory(bl602, bl616, bl616cl, bl618dg, bl606p);
  root.BflbFlashTargets = api;
  if (isNode) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function (bl602, bl616, bl616cl, bl618dg, bl606p) {
  "use strict";
  const CHIP_DEFS = Object.freeze({ bl602, bl616, bl616cl, bl618dg, bl606p });
  return Object.freeze({ BL602: bl602, BL616: bl616, BL616CL: bl616cl, BL618DG: bl618dg, BL606P: bl606p, CHIP_DEFS });
});
