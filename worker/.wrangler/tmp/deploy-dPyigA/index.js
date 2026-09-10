var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/common/http.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Token, X-Admin-Token",
  "Access-Control-Max-Age": "86400"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });
}
__name(json, "json");

// src/common/user.js
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
__name(fnv1a, "fnv1a");
function userKey(token, name) {
  return token ? `u:${fnv1a(token)}:${name}` : `shared:${name}`;
}
__name(userKey, "userKey");
async function getUserConfig(env, token) {
  const key = userKey(token, "config");
  const cfg = await env.MAOYAN_KV.get(key, "json");
  return cfg || {};
}
__name(getUserConfig, "getUserConfig");
async function cleanupUserData(env, token) {
  for (const name of ["config", "snapshot", "changes", "status"]) {
    try {
      await env.MAOYAN_KV.delete(userKey(token, name));
    } catch (e) {
    }
  }
}
__name(cleanupUserData, "cleanupUserData");

// src/maoyan/cities.js
var CITY_LIST = [
  { id: 10, name: "\u4E0A\u6D77" },
  { id: 1, name: "\u5317\u4EAC" },
  { id: 20, name: "\u5E7F\u5DDE" },
  { id: 30, name: "\u6DF1\u5733" },
  { id: 57, name: "\u6B66\u6C49" },
  { id: 40, name: "\u5929\u6D25" },
  { id: 42, name: "\u897F\u5B89" },
  { id: 55, name: "\u5357\u4EAC" },
  { id: 50, name: "\u676D\u5DDE" },
  { id: 59, name: "\u6210\u90FD" },
  { id: 45, name: "\u91CD\u5E86" },
  { id: 150, name: "\u963F\u62C9\u5584\u76DF" },
  { id: 151, name: "\u978D\u5C71" },
  { id: 197, name: "\u5B89\u5E86" },
  { id: 238, name: "\u5B89\u9633" },
  { id: 319, name: "\u963F\u575D" },
  { id: 324, name: "\u5B89\u987A" },
  { id: 350, name: "\u963F\u91CC" },
  { id: 359, name: "\u5B89\u5EB7" },
  { id: 394, name: "\u963F\u514B\u82CF" },
  { id: 400, name: "\u963F\u52D2\u6CF0" },
  { id: 490, name: "\u5B89\u5409" },
  { id: 588, name: "\u5B89\u4E18" },
  { id: 699, name: "\u5B89\u5CB3" },
  { id: 807, name: "\u5B89\u5E73" },
  { id: 844, name: "\u5B89\u6EAA" },
  { id: 873, name: "\u5B89\u5B81" },
  { id: 1008, name: "\u5B89\u5316" },
  { id: 1016, name: "\u963F\u62C9\u5C14" },
  { id: 1068, name: "\u5B89\u798F" },
  { id: 1126, name: "\u963F\u52D2\u6CF0\u5E02" },
  { id: 1190, name: "\u963F\u56FE\u4EC0\u5E02" },
  { id: 1212, name: "\u5B89\u5DDE\u533A" },
  { id: 1229, name: "\u963F\u8363\u65D7" },
  { id: 1245, name: "\u5B89\u9646\u5E02" },
  { id: 1280, name: "\u963F\u57CE\u533A" },
  { id: 84, name: "\u4FDD\u5B9A" },
  { id: 88, name: "\u868C\u57E0" },
  { id: 140, name: "\u5305\u5934" },
  { id: 146, name: "\u5DF4\u5F66\u6DD6\u5C14" },
  { id: 153, name: "\u672C\u6EAA" },
  { id: 165, name: "\u767D\u5C71" },
  { id: 167, name: "\u767D\u57CE" },
  { id: 204, name: "\u4EB3\u5DDE" },
  { id: 233, name: "\u6EE8\u5DDE" },
  { id: 292, name: "\u5317\u6D77" },
  { id: 297, name: "\u767E\u8272" },
  { id: 317, name: "\u5DF4\u4E2D" },
  { id: 327, name: "\u6BD5\u8282" },
  { id: 332, name: "\u4FDD\u5C71" },
  { id: 353, name: "\u5B9D\u9E21" },
  { id: 363, name: "\u767D\u94F6" },
  { id: 392, name: "\u535A\u5C14\u5854\u62C9" },
  { id: 393, name: "\u5DF4\u5DDE" },
  { id: 533, name: "\u6EE8\u6D77" },
  { id: 575, name: "\u9738\u5DDE" },
  { id: 602, name: "\u5B9D\u5E94" },
  { id: 681, name: "\u5317\u6D41" },
  { id: 698, name: "\u535A\u7231" },
  { id: 731, name: "\u5317\u789A" },
  { id: 783, name: "\u5B9D\u4E30" },
  { id: 852, name: "\u535A\u5174" },
  { id: 887, name: "\u6CCC\u9633" },
  { id: 915, name: "\u5F6C\u5DDE\u5E02" },
  { id: 946, name: "\u74A7\u5C71" },
  { id: 952, name: "\u535A\u5C71" },
  { id: 994, name: "\u5BBE\u9633" },
  { id: 1074, name: "\u6CCA\u5934\u5E02" },
  { id: 1098, name: "\u535A\u7F57\u53BF" },
  { id: 1102, name: "\u535A\u767D\u53BF" },
  { id: 1141, name: "\u5317\u9547\u5E02" },
  { id: 1165, name: "\u5317\u5B89\u5E02" },
  { id: 1193, name: "\u5DF4\u5F66\u53BF" },
  { id: 1237, name: "\u5DF4\u695A\u53BF" },
  { id: 1304, name: "\u4FDD\u4EAD\u9ECE\u65CF\u82D7\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1305, name: "\u767D\u6C99\u9ECE\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1306, name: "\u5317\u5C6F\u5E02" },
  { id: 70, name: "\u957F\u6C99" },
  { id: 89, name: "\u5E38\u5DDE" },
  { id: 116, name: "\u957F\u6625" },
  { id: 126, name: "\u627F\u5FB7" },
  { id: 127, name: "\u6CA7\u5DDE" },
  { id: 131, name: "\u957F\u6CBB" },
  { id: 142, name: "\u8D64\u5CF0" },
  { id: 160, name: "\u671D\u9633" },
  { id: 199, name: "\u6EC1\u5DDE" },
  { id: 202, name: "\u5DE2\u6E56" },
  { id: 205, name: "\u6C60\u5DDE" },
  { id: 268, name: "\u5E38\u5FB7" },
  { id: 271, name: "\u90F4\u5DDE" },
  { id: 287, name: "\u6F6E\u5DDE" },
  { id: 301, name: "\u5D07\u5DE6" },
  { id: 337, name: "\u695A\u96C4" },
  { id: 346, name: "\u660C\u90FD" },
  { id: 391, name: "\u660C\u5409" },
  { id: 421, name: "\u4ECE\u5316" },
  { id: 422, name: "\u5E38\u719F" },
  { id: 451, name: "\u6148\u6EAA" },
  { id: 452, name: "\u957F\u5174" },
  { id: 463, name: "\u957F\u4E50" },
  { id: 527, name: "\u660C\u9091" },
  { id: 624, name: "\u82CD\u5357" },
  { id: 627, name: "\u957F\u845B" },
  { id: 646, name: "\u5D07\u5DDE" },
  { id: 653, name: "\u8D64\u58C1" },
  { id: 660, name: "\u6DF3\u5B89" },
  { id: 700, name: "\u627F\u5FB7\u53BF" },
  { id: 737, name: "\u660C\u4E50" },
  { id: 746, name: "\u66F9\u5983\u7538" },
  { id: 767, name: "\u78C1\u53BF" },
  { id: 795, name: "\u957F\u57A3\u5E02" },
  { id: 798, name: "\u6210\u5B89" },
  { id: 801, name: "\u660C\u9ECE" },
  { id: 811, name: "\u5C91\u6EAA" },
  { id: 877, name: "\u830C\u5E73\u533A" },
  { id: 883, name: "\u66F9\u53BF" },
  { id: 909, name: "\u57CE\u56FA" },
  { id: 954, name: "\u957F\u6C40" },
  { id: 970, name: "\u6F6E\u5B89" },
  { id: 981, name: "\u957F\u5BFF" },
  { id: 993, name: "\u5E38\u5C71" },
  { id: 1018, name: "\u8D64\u6C34" },
  { id: 1078, name: "\u6148\u5229" },
  { id: 1092, name: "\u5E38\u5B81\u5E02" },
  { id: 1097, name: "\u8336\u9675" },
  { id: 1100, name: "\u957F\u4E30\u53BF" },
  { id: 1150, name: "\u82CD\u6EAA\u53BF" },
  { id: 1157, name: "\u957F\u6E05\u533A" },
  { id: 1164, name: "\u5D07\u660E\u533A" },
  { id: 1201, name: "\u6210\u6B66\u53BF" },
  { id: 1205, name: "\u6F84\u6C5F\u5E02" },
  { id: 1269, name: "\u6F84\u8FC8\u53BF" },
  { id: 1291, name: "\u660C\u6C5F\u9ECE\u65CF\u81EA\u6CBB\u53BF" },
  { id: 65, name: "\u5927\u8FDE" },
  { id: 90, name: "\u5927\u5E86" },
  { id: 91, name: "\u4E1C\u839E" },
  { id: 129, name: "\u5927\u540C" },
  { id: 154, name: "\u4E39\u4E1C" },
  { id: 178, name: "\u5927\u5174\u5B89\u5CAD" },
  { id: 223, name: "\u4E1C\u8425" },
  { id: 231, name: "\u5FB7\u5DDE" },
  { id: 305, name: "\u5FB7\u9633" },
  { id: 315, name: "\u8FBE\u5DDE" },
  { id: 341, name: "\u5927\u7406" },
  { id: 342, name: "\u5FB7\u5B8F" },
  { id: 344, name: "\u8FEA\u5E86" },
  { id: 370, name: "\u5B9A\u897F" },
  { id: 431, name: "\u4E39\u9633" },
  { id: 434, name: "\u6566\u714C" },
  { id: 455, name: "\u4E1C\u9633" },
  { id: 467, name: "\u5FB7\u6E05" },
  { id: 477, name: "\u5927\u4E30" },
  { id: 478, name: "\u4E1C\u53F0" },
  { id: 491, name: "\u5F53\u9633" },
  { id: 539, name: "\u4E1C\u6E2F" },
  { id: 552, name: "\u767B\u5C01" },
  { id: 571, name: "\u510B\u5DDE" },
  { id: 576, name: "\u90FD\u6C5F\u5830" },
  { id: 599, name: "\u5927\u77F3\u6865" },
  { id: 600, name: "\u5927\u51B6" },
  { id: 635, name: "\u4E1C\u5174" },
  { id: 642, name: "\u8C03\u5175\u5C71" },
  { id: 651, name: "\u706F\u5854" },
  { id: 662, name: "\u9093\u5DDE" },
  { id: 679, name: "\u5927\u901A" },
  { id: 686, name: "\u4E1C\u65B9" },
  { id: 738, name: "\u4E1C\u5E73" },
  { id: 750, name: "\u7535\u767D" },
  { id: 754, name: "\u4E1C\u6D77" },
  { id: 765, name: "\u5B9A\u5DDE" },
  { id: 835, name: "\u90F8\u57CE" },
  { id: 836, name: "\u5927\u8354" },
  { id: 874, name: "\u8FBE\u62C9\u7279\u65D7" },
  { id: 910, name: "\u5927\u7AF9" },
  { id: 945, name: "\u5927\u6D3C" },
  { id: 971, name: "\u5927\u9091" },
  { id: 974, name: "\u7800\u5C71" },
  { id: 978, name: "\u6566\u5316" },
  { id: 999, name: "\u4E1C\u5149" },
  { id: 1035, name: "\u9053\u53BF" },
  { id: 1076, name: "\u5927\u5B89\u5E02" },
  { id: 1168, name: "\u5B9A\u5B89\u53BF" },
  { id: 1177, name: "\u57AB\u6C5F" },
  { id: 1203, name: "\u4E1C\u660E\u53BF" },
  { id: 1204, name: "\u5B9A\u9676\u533A" },
  { id: 1208, name: "\u5B9A\u8FB9\u53BF" },
  { id: 1233, name: "\u5927\u5382\u56DE\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1242, name: "\u5B9A\u8FDC\u53BF" },
  { id: 1243, name: "\u5927\u609F\u53BF" },
  { id: 1268, name: "\u5927\u8DB3\u533A" },
  { id: 1271, name: "\u5FB7\u60E0\u5E02" },
  { id: 1275, name: "\u4E1C\u5751\u9547" },
  { id: 1285, name: "\u4E1C\u963F\u53BF" },
  { id: 144, name: "\u9102\u5C14\u591A\u65AF" },
  { id: 254, name: "\u9102\u5DDE" },
  { id: 261, name: "\u6069\u65BD" },
  { id: 417, name: "\u5CE8\u7709\u5C71" },
  { id: 568, name: "\u989D\u5C14\u53E4\u7EB3" },
  { id: 989, name: "\u6069\u5E73" },
  { id: 1172, name: "\u989D\u654F\u53BF" },
  { id: 44, name: "\u798F\u5DDE" },
  { id: 92, name: "\u4F5B\u5C71" },
  { id: 152, name: "\u629A\u987A" },
  { id: 156, name: "\u961C\u65B0" },
  { id: 200, name: "\u961C\u9633" },
  { id: 220, name: "\u629A\u5DDE" },
  { id: 293, name: "\u9632\u57CE\u6E2F" },
  { id: 416, name: "\u5BCC\u9633" },
  { id: 427, name: "\u6DAA\u9675" },
  { id: 462, name: "\u798F\u6E05" },
  { id: 480, name: "\u51E4\u51F0" },
  { id: 535, name: "\u961C\u5B81" },
  { id: 540, name: "\u5949\u5316" },
  { id: 545, name: "\u80A5\u57CE" },
  { id: 665, name: "\u51E4\u57CE" },
  { id: 677, name: "\u6C7E\u9633" },
  { id: 689, name: "\u961C\u5EB7" },
  { id: 735, name: "\u4E30\u57CE" },
  { id: 742, name: "\u8303\u53BF" },
  { id: 774, name: "\u7E41\u660C\u533A" },
  { id: 792, name: "\u80A5\u4E61\u533A" },
  { id: 827, name: "\u5C01\u4E18" },
  { id: 861, name: "\u6276\u98CE" },
  { id: 862, name: "\u4E30\u53BF" },
  { id: 869, name: "\u629A\u677E" },
  { id: 888, name: "\u5BCC\u987A" },
  { id: 916, name: "\u8D39\u53BF" },
  { id: 921, name: "\u4F5B\u5188" },
  { id: 924, name: "\u4E30\u5B81" },
  { id: 937, name: "\u6276\u6C9F" },
  { id: 980, name: "\u51E4\u53F0" },
  { id: 1031, name: "\u5949\u65B0" },
  { id: 1052, name: "\u65B9\u57CE" },
  { id: 1066, name: "\u5BCC\u6E90\u53BF" },
  { id: 1070, name: "\u5206\u5B9C" },
  { id: 1084, name: "\u6276\u7EE5\u53BF" },
  { id: 1142, name: "\u80A5\u897F\u53BF" },
  { id: 1148, name: "\u7E41\u5CD9\u53BF" },
  { id: 1152, name: "\u51E4\u7FD4\u533A" },
  { id: 1195, name: "\u798F\u5B89" },
  { id: 1202, name: "\u798F\u9F0E\u5E02" },
  { id: 1209, name: "\u5E9C\u8C37\u53BF" },
  { id: 1230, name: "\u5949\u8282" },
  { id: 1231, name: "\u4E30\u90FD" },
  { id: 1241, name: "\u80A5\u4E1C\u53BF" },
  { id: 1253, name: "\u5BCC\u6C11" },
  { id: 93, name: "\u6842\u6797" },
  { id: 107, name: "\u8D35\u9633" },
  { id: 217, name: "\u8D63\u5DDE" },
  { id: 295, name: "\u8D35\u6E2F" },
  { id: 307, name: "\u5E7F\u5143" },
  { id: 314, name: "\u5E7F\u5B89" },
  { id: 320, name: "\u7518\u5B5C" },
  { id: 373, name: "\u7518\u5357" },
  { id: 385, name: "\u56FA\u539F" },
  { id: 521, name: "\u9AD8\u90AE" },
  { id: 541, name: "\u5E7F\u9976" },
  { id: 553, name: "\u5DE9\u4E49" },
  { id: 570, name: "\u6842\u5E73" },
  { id: 581, name: "\u516C\u4E3B\u5CAD" },
  { id: 589, name: "\u9AD8\u5BC6" },
  { id: 593, name: "\u5E7F\u6C49" },
  { id: 595, name: "\u85C1\u57CE" },
  { id: 601, name: "\u9AD8\u5E73" },
  { id: 629, name: "\u9AD8\u7891\u5E97" },
  { id: 630, name: "\u4E2A\u65E7" },
  { id: 631, name: "\u9AD8\u5DDE" },
  { id: 638, name: "\u76D6\u5DDE" },
  { id: 691, name: "\u53E4\u4EA4" },
  { id: 702, name: "\u683C\u5C14\u6728" },
  { id: 751, name: "\u704C\u4E91" },
  { id: 752, name: "\u704C\u5357" },
  { id: 753, name: "\u8D63\u6986" },
  { id: 771, name: "\u9AD8\u5B89" },
  { id: 780, name: "\u5E7F\u5FB7\u5E02" },
  { id: 787, name: "\u5171\u9752\u57CE" },
  { id: 854, name: "\u9AD8\u9633" },
  { id: 866, name: "\u9AD8\u9675" },
  { id: 911, name: "\u516C\u5B89" },
  { id: 1104, name: "\u56FA\u59CB\u53BF" },
  { id: 1174, name: "\u5149\u6CFD" },
  { id: 1239, name: "\u5149\u5C71\u53BF" },
  { id: 1274, name: "\u56FA\u5B89\u53BF" },
  { id: 1290, name: "\u9AD8\u6DF3\u533A" },
  { id: 56, name: "\u5408\u80A5" },
  { id: 94, name: "\u6D77\u53E3" },
  { id: 95, name: "\u846B\u82A6\u5C9B" },
  { id: 105, name: "\u54C8\u5C14\u6EE8" },
  { id: 123, name: "\u90AF\u90F8" },
  { id: 128, name: "\u8861\u6C34" },
  { id: 139, name: "\u547C\u548C\u6D69\u7279" },
  { id: 145, name: "\u547C\u4F26\u8D1D\u5C14" },
  { id: 170, name: "\u9E64\u5C97" },
  { id: 176, name: "\u9ED1\u6CB3" },
  { id: 180, name: "\u6DEE\u5B89" },
  { id: 186, name: "\u6E56\u5DDE" },
  { id: 193, name: "\u6DEE\u5357" },
  { id: 195, name: "\u6DEE\u5317" },
  { id: 198, name: "\u9EC4\u5C71" },
  { id: 234, name: "\u83CF\u6CFD" },
  { id: 239, name: "\u9E64\u58C1" },
  { id: 250, name: "\u9EC4\u77F3" },
  { id: 258, name: "\u9EC4\u5188" },
  { id: 265, name: "\u8861\u9633" },
  { id: 273, name: "\u6000\u5316" },
  { id: 281, name: "\u60E0\u5DDE" },
  { id: 284, name: "\u6CB3\u6E90" },
  { id: 298, name: "\u8D3A\u5DDE" },
  { id: 299, name: "\u6CB3\u6C60" },
  { id: 338, name: "\u7EA2\u6CB3" },
  { id: 357, name: "\u6C49\u4E2D" },
  { id: 375, name: "\u6D77\u4E1C" },
  { id: 376, name: "\u6D77\u5317" },
  { id: 377, name: "\u9EC4\u5357" },
  { id: 378, name: "\u6D77\u5357\u5DDE" },
  { id: 381, name: "\u6D77\u897F" },
  { id: 390, name: "\u54C8\u5BC6" },
  { id: 397, name: "\u548C\u7530" },
  { id: 424, name: "\u6D77\u5B81" },
  { id: 471, name: "\u60E0\u4E1C" },
  { id: 472, name: "\u60E0\u9633" },
  { id: 504, name: "\u9E64\u5C71" },
  { id: 505, name: "\u6866\u7538" },
  { id: 506, name: "\u6D77\u57CE" },
  { id: 519, name: "\u6D77\u95E8\u533A" },
  { id: 573, name: "\u6D77\u9633" },
  { id: 579, name: "\u4FAF\u9A6C" },
  { id: 598, name: "\u6CB3\u6D25" },
  { id: 623, name: "\u6D77\u5B89" },
  { id: 645, name: "\u970D\u5DDE" },
  { id: 650, name: "\u9EC4\u9A85" },
  { id: 672, name: "\u5316\u5DDE" },
  { id: 685, name: "\u6D77\u6797" },
  { id: 726, name: "\u6D77\u76D0" },
  { id: 732, name: "\u5408\u5DDD" },
  { id: 758, name: "\u6DEE\u9633\u533A" },
  { id: 772, name: "\u6C49\u9634" },
  { id: 793, name: "\u542B\u5C71" },
  { id: 794, name: "\u548C\u53BF" },
  { id: 799, name: "\u9120\u9091\u533A" },
  { id: 800, name: "\u8F89\u53BF" },
  { id: 806, name: "\u6000\u4EC1\u5E02" },
  { id: 816, name: "\u6ED1\u53BF" },
  { id: 825, name: "\u60E0\u5B89" },
  { id: 832, name: "\u97E9\u57CE" },
  { id: 851, name: "\u6A2A\u5E97" },
  { id: 856, name: "\u534E\u4EAD\u5E02" },
  { id: 867, name: "\u6D2A\u6D1E" },
  { id: 881, name: "\u6CB3\u53E3" },
  { id: 894, name: "\u8F89\u5357" },
  { id: 928, name: "\u6D2A\u6E56" },
  { id: 964, name: "\u6D77\u6CA7" },
  { id: 975, name: "\u970D\u90B1" },
  { id: 977, name: "\u73F2\u6625" },
  { id: 1005, name: "\u6000\u5B81" },
  { id: 1042, name: "\u6000\u8FDC\u53BF" },
  { id: 1065, name: "\u4F1A\u6CFD\u53BF" },
  { id: 1080, name: "\u6CB3\u95F4\u5E02" },
  { id: 1086, name: "\u5408\u6D66\u53BF" },
  { id: 1088, name: "\u8861\u9633\u53BF" },
  { id: 1090, name: "\u8861\u5C71\u53BF" },
  { id: 1091, name: "\u8861\u4E1C\u53BF" },
  { id: 1103, name: "\u6F62\u5DDD\u53BF" },
  { id: 1105, name: "\u8D3A\u5170\u53BF" },
  { id: 1124, name: "\u6C49\u5357\u533A" },
  { id: 1130, name: "\u6D77\u4F26\u5E02" },
  { id: 1145, name: "\u5408\u6C5F\u53BF" },
  { id: 1185, name: "\u73AF\u53BF" },
  { id: 1206, name: "\u9EC4\u9675\u53BF" },
  { id: 8001, name: "\u534E\u5BB9" },
  { id: 96, name: "\u6D4E\u5357" },
  { id: 97, name: "\u7126\u4F5C" },
  { id: 98, name: "\u9526\u5DDE" },
  { id: 115, name: "\u4E5D\u6C5F" },
  { id: 132, name: "\u664B\u57CE" },
  { id: 134, name: "\u664B\u4E2D" },
  { id: 161, name: "\u5409\u6797" },
  { id: 169, name: "\u9E21\u897F" },
  { id: 173, name: "\u4F73\u6728\u65AF" },
  { id: 185, name: "\u5609\u5174" },
  { id: 188, name: "\u91D1\u534E" },
  { id: 213, name: "\u666F\u5FB7\u9547" },
  { id: 218, name: "\u5409\u5B89" },
  { id: 225, name: "\u6D4E\u5B81" },
  { id: 249, name: "\u6D4E\u6E90" },
  { id: 255, name: "\u8346\u95E8" },
  { id: 257, name: "\u8346\u5DDE" },
  { id: 277, name: "\u6C5F\u95E8" },
  { id: 288, name: "\u63ED\u9633" },
  { id: 362, name: "\u91D1\u660C" },
  { id: 368, name: "\u9152\u6CC9" },
  { id: 404, name: "\u6C5F\u9634" },
  { id: 409, name: "\u5609\u5CEA\u5173" },
  { id: 420, name: "\u664B\u6C5F\u5E02" },
  { id: 439, name: "\u9756\u6C5F" },
  { id: 460, name: "\u91D1\u575B" },
  { id: 483, name: "\u4E5D\u5BE8\u6C9F" },
  { id: 485, name: "\u4E95\u5188\u5C71" },
  { id: 489, name: "\u5609\u5584" },
  { id: 510, name: "\u6C5F\u5C71" },
  { id: 515, name: "\u53E5\u5BB9" },
  { id: 536, name: "\u5EFA\u6E56" },
  { id: 544, name: "\u664B\u5DDE" },
  { id: 583, name: "\u80F6\u5DDE" },
  { id: 594, name: "\u5EFA\u5FB7" },
  { id: 605, name: "\u7B80\u9633" },
  { id: 636, name: "\u4ECB\u4F11" },
  { id: 664, name: "\u5373\u58A8" },
  { id: 678, name: "\u96C6\u5B89" },
  { id: 725, name: "\u86DF\u6CB3" },
  { id: 756, name: "\u5EFA\u9633" },
  { id: 785, name: "\u90CF\u53BF" },
  { id: 788, name: "\u91D1\u5802\u53BF" },
  { id: 831, name: "\u76D1\u5229\u5E02" },
  { id: 871, name: "\u6C5F\u6D25" },
  { id: 882, name: "\u5DE8\u91CE" },
  { id: 899, name: "\u5609\u7965" },
  { id: 900, name: "\u91D1\u4E61" },
  { id: 913, name: "\u7F19\u4E91" },
  { id: 918, name: "\u4EAC\u5C71\u5E02" },
  { id: 927, name: "\u6C5F\u6CB9" },
  { id: 941, name: "\u8392\u5357" },
  { id: 948, name: "\u6C5F\u90FD" },
  { id: 956, name: "\u91D1\u6E56" },
  { id: 963, name: "\u96C6\u7F8E" },
  { id: 1001, name: "\u91D1\u6C99" },
  { id: 1003, name: "\u6CFE\u53BF" },
  { id: 1028, name: "\u5409\u5B89\u53BF" },
  { id: 1029, name: "\u5409\u6C34\u53BF" },
  { id: 1032, name: "\u6C5F\u5DDD\u53BF" },
  { id: 1038, name: "\u6C5F\u534E\u7476\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1059, name: "\u664B\u5B81\u533A" },
  { id: 1061, name: "\u6C5F\u6C38" },
  { id: 1085, name: "\u5EFA\u6C34\u53BF" },
  { id: 1134, name: "\u9104\u57CE\u53BF" },
  { id: 1146, name: "\u9756\u8FB9" },
  { id: 1153, name: "\u5609\u9C7C\u53BF" },
  { id: 1194, name: "\u7CBE\u6CB3\u53BF" },
  { id: 1197, name: "\u9756\u897F\u5E02" },
  { id: 1252, name: "\u666F\u8C37" },
  { id: 1263, name: "\u4E5D\u53F0" },
  { id: 1288, name: "\u6CFE\u9633\u53BF" },
  { id: 114, name: "\u6606\u660E" },
  { id: 235, name: "\u5F00\u5C01" },
  { id: 388, name: "\u514B\u62C9\u739B\u4F9D" },
  { id: 395, name: "\u514B\u5DDE" },
  { id: 396, name: "\u5580\u4EC0\u5730\u533A" },
  { id: 403, name: "\u6606\u5C71" },
  { id: 473, name: "\u51EF\u91CC" },
  { id: 502, name: "\u5F00\u5E73" },
  { id: 603, name: "\u5E93\u5C14\u52D2" },
  { id: 643, name: "\u594E\u5C6F" },
  { id: 748, name: "\u5F00\u5DDE\u533A" },
  { id: 880, name: "\u57A6\u5229" },
  { id: 925, name: "\u5BBD\u57CE" },
  { id: 984, name: "\u5E93\u8F66\u5E02" },
  { id: 990, name: "\u5F00\u5316" },
  { id: 1002, name: "\u5F00\u9633" },
  { id: 1227, name: "\u5EB7\u53BF" },
  { id: 1293, name: "\u5F00\u8FDC\u5E02" },
  { id: 1297, name: "\u53EF\u514B\u8FBE\u62C9\u5E02" },
  { id: 1298, name: "\u6606\u7389\u5E02" },
  { id: 106, name: "\u5ECA\u574A" },
  { id: 137, name: "\u4E34\u6C7E" },
  { id: 138, name: "\u5415\u6881" },
  { id: 157, name: "\u8FBD\u9633" },
  { id: 163, name: "\u8FBD\u6E90" },
  { id: 179, name: "\u8FDE\u4E91\u6E2F" },
  { id: 192, name: "\u4E3D\u6C34" },
  { id: 203, name: "\u516D\u5B89" },
  { id: 211, name: "\u9F99\u5CA9" },
  { id: 229, name: "\u83B1\u829C" },
  { id: 230, name: "\u4E34\u6C82" },
  { id: 232, name: "\u804A\u57CE" },
  { id: 236, name: "\u6D1B\u9633" },
  { id: 242, name: "\u6F2F\u6CB3" },
  { id: 274, name: "\u5A04\u5E95" },
  { id: 290, name: "\u67F3\u5DDE" },
  { id: 300, name: "\u6765\u5BBE" },
  { id: 304, name: "\u6CF8\u5DDE" },
  { id: 310, name: "\u4E50\u5C71" },
  { id: 321, name: "\u51C9\u5C71" },
  { id: 322, name: "\u516D\u76D8\u6C34" },
  { id: 334, name: "\u4E3D\u6C5F" },
  { id: 336, name: "\u4E34\u6CA7" },
  { id: 345, name: "\u62C9\u8428" },
  { id: 351, name: "\u6797\u829D" },
  { id: 361, name: "\u5170\u5DDE" },
  { id: 371, name: "\u9647\u5357" },
  { id: 372, name: "\u4E34\u590F" },
  { id: 450, name: "\u6EA7\u9633" },
  { id: 461, name: "\u4E34\u6D77" },
  { id: 476, name: "\u5170\u6EAA" },
  { id: 492, name: "\u9F99\u53E3" },
  { id: 509, name: "\u8012\u9633" },
  { id: 513, name: "\u4E50\u660C" },
  { id: 529, name: "\u83B1\u5DDE" },
  { id: 537, name: "\u4E34\u6E05" },
  { id: 542, name: "\u4E34\u5B89" },
  { id: 561, name: "\u83B1\u9633" },
  { id: 567, name: "\u9646\u4E30" },
  { id: 596, name: "\u7075\u5B9D" },
  { id: 606, name: "\u51B7\u6C34\u6C5F" },
  { id: 611, name: "\u4E50\u9675" },
  { id: 617, name: "\u6D4F\u9633" },
  { id: 618, name: "\u9F99\u6D77\u533A" },
  { id: 619, name: "\u91B4\u9675" },
  { id: 620, name: "\u83B1\u897F" },
  { id: 628, name: "\u5EC9\u6C5F" },
  { id: 632, name: "\u4E50\u5E73" },
  { id: 634, name: "\u9606\u4E2D" },
  { id: 652, name: "\u9E7F\u6CC9" },
  { id: 655, name: "\u5229\u5DDD" },
  { id: 659, name: "\u8001\u6CB3\u53E3" },
  { id: 670, name: "\u51CC\u6D77" },
  { id: 674, name: "\u6EE6\u5357" },
  { id: 675, name: "\u7075\u5C71" },
  { id: 683, name: "\u8FDE\u5DDE" },
  { id: 688, name: "\u9675\u6C34" },
  { id: 690, name: "\u4E34\u6C5F" },
  { id: 724, name: "\u8FDE\u6C5F" },
  { id: 739, name: "\u4E34\u6710" },
  { id: 744, name: "\u4E50\u4EAD" },
  { id: 745, name: "\u6EE6\u5DDE\u5E02" },
  { id: 766, name: "\u683E\u57CE" },
  { id: 786, name: "\u9C81\u5C71" },
  { id: 789, name: "\u7075\u77F3" },
  { id: 791, name: "\u4E34\u6F33" },
  { id: 808, name: "\u4E34\u6F7C" },
  { id: 809, name: "\u84DD\u7530" },
  { id: 815, name: "\u6797\u5DDE" },
  { id: 823, name: "\u9686\u660C\u5E02" },
  { id: 839, name: "\u9E7F\u9091" },
  { id: 868, name: "\u67F3\u6CB3" },
  { id: 889, name: "\u4E34\u7317" },
  { id: 896, name: "\u6881\u5C71" },
  { id: 902, name: "\u5229\u6D25" },
  { id: 905, name: "\u4E34\u9091" },
  { id: 912, name: "\u9F99\u6CC9" },
  { id: 919, name: "\u9675\u5DDD" },
  { id: 930, name: "\u9686\u5C27" },
  { id: 934, name: "\u96F7\u5DDE" },
  { id: 935, name: "\u683E\u5DDD" },
  { id: 938, name: "\u9F99\u6E38" },
  { id: 939, name: "\u5170\u9675" },
  { id: 951, name: "\u4E34\u6CAD" },
  { id: 976, name: "\u6D9F\u6C34" },
  { id: 1010, name: "\u6FA7\u53BF" },
  { id: 1011, name: "\u8FBD\u4E2D" },
  { id: 1034, name: "\u7F57\u5E73\u53BF" },
  { id: 1037, name: "\u6D9F\u6E90\u5E02" },
  { id: 1040, name: "\u5E90\u6C5F\u53BF" },
  { id: 1056, name: "\u4E34\u988D" },
  { id: 1060, name: "\u84DD\u5C71" },
  { id: 1064, name: "\u9686\u56DE" },
  { id: 1073, name: "\u82A6\u6EAA" },
  { id: 1079, name: "\u5362\u6C0F\u53BF" },
  { id: 1083, name: "\u9686\u5316\u53BF" },
  { id: 1087, name: "\u6D1B\u5B81" },
  { id: 1110, name: "\u5170\u8003\u53BF" },
  { id: 1119, name: "\u4E34\u6FA7" },
  { id: 1121, name: "\u5229\u8F9B" },
  { id: 1133, name: "\u7075\u4E18\u53BF" },
  { id: 1138, name: "\u7984\u4E30\u5E02" },
  { id: 1143, name: "\u6EA7\u6C34\u533A" },
  { id: 1144, name: "\u6CF8\u53BF" },
  { id: 1147, name: "\u6D1B\u5DDD\u53BF" },
  { id: 1163, name: "\u7F57\u5B9A\u5E02" },
  { id: 1171, name: "\u4E50\u4E1C" },
  { id: 1178, name: "\u6881\u5E73" },
  { id: 1183, name: "\u4E34\u9AD8\u53BF" },
  { id: 1184, name: "\u7F57\u6E90\u53BF" },
  { id: 1225, name: "\u9646\u5DDD\u53BF" },
  { id: 1247, name: "\u4E34\u6CC9\u53BF" },
  { id: 1254, name: "\u7984\u529D\u5F5D\u65CF\u82D7\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1281, name: "\u7075\u6B66\u5E02" },
  { id: 175, name: "\u7261\u4E39\u6C5F" },
  { id: 194, name: "\u9A6C\u978D\u5C71" },
  { id: 279, name: "\u8302\u540D" },
  { id: 282, name: "\u6885\u5DDE" },
  { id: 306, name: "\u7EF5\u9633" },
  { id: 312, name: "\u7709\u5C71" },
  { id: 563, name: "\u6F20\u6CB3\u5E02" },
  { id: 566, name: "\u5BC6\u5C71" },
  { id: 572, name: "\u6EE1\u6D32\u91CC" },
  { id: 584, name: "\u6885\u6CB3\u53E3" },
  { id: 590, name: "\u6C68\u7F57" },
  { id: 610, name: "\u660E\u5149" },
  { id: 668, name: "\u9EBB\u57CE" },
  { id: 694, name: "\u5B5F\u5DDE" },
  { id: 838, name: "\u5B5F\u6D25\u533A" },
  { id: 846, name: "\u725F\u5E73" },
  { id: 848, name: "\u7709\u53BF" },
  { id: 860, name: "\u6C11\u6743" },
  { id: 872, name: "\u6E11\u6C60" },
  { id: 906, name: "\u7EF5\u7AF9" },
  { id: 944, name: "\u8499\u9634" },
  { id: 1116, name: "\u8499\u81EA\u5E02" },
  { id: 1122, name: "\u8499\u57CE" },
  { id: 1210, name: "\u52D0\u814A\u53BF" },
  { id: 1216, name: "\u7C73\u6613\u53BF" },
  { id: 1219, name: "\u95FD\u4FAF\u53BF" },
  { id: 1222, name: "\u660E\u6C34\u53BF" },
  { id: 1283, name: "\u95E8\u5934\u6C9F\u533A" },
  { id: 51, name: "\u5B81\u6CE2" },
  { id: 82, name: "\u5357\u901A" },
  { id: 83, name: "\u5357\u660C" },
  { id: 99, name: "\u5357\u5B81" },
  { id: 210, name: "\u5357\u5E73" },
  { id: 212, name: "\u5B81\u5FB7" },
  { id: 244, name: "\u5357\u9633" },
  { id: 309, name: "\u5185\u6C5F" },
  { id: 311, name: "\u5357\u5145" },
  { id: 343, name: "\u6012\u6C5F" },
  { id: 349, name: "\u90A3\u66F2" },
  { id: 512, name: "\u5B81\u6D77" },
  { id: 520, name: "\u5B81\u4E61" },
  { id: 547, name: "\u5357\u6C99" },
  { id: 621, name: "\u5357\u5B89" },
  { id: 682, name: "\u8BB7\u6CB3" },
  { id: 687, name: "\u5357\u96C4" },
  { id: 741, name: "\u5357\u4E50" },
  { id: 775, name: "\u5357\u9675" },
  { id: 779, name: "\u5B81\u9633" },
  { id: 781, name: "\u5B81\u56FD" },
  { id: 813, name: "\u5B81\u664B" },
  { id: 820, name: "\u5B81\u6D25" },
  { id: 931, name: "\u5185\u4E18" },
  { id: 932, name: "\u5357\u5BAB" },
  { id: 979, name: "\u5185\u9EC4" },
  { id: 1013, name: "\u5357\u548C\u533A" },
  { id: 1053, name: "\u5357\u90E8\u53BF" },
  { id: 1075, name: "\u5357\u76AE\u53BF" },
  { id: 1112, name: "\u5B81\u9675" },
  { id: 1125, name: "\u5357\u90D1\u533A" },
  { id: 1161, name: "\u5B81\u8497\u5F5D\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1166, name: "\u5AE9\u6C5F\u5E02" },
  { id: 1224, name: "\u5B81\u8FDC\u53BF" },
  { id: 1264, name: "\u5357\u5DDD" },
  { id: 1300, name: "\u519C\u5B89\u53BF" },
  { id: 158, name: "\u76D8\u9526" },
  { id: 207, name: "\u8386\u7530" },
  { id: 214, name: "\u840D\u4E61" },
  { id: 237, name: "\u5E73\u9876\u5C71" },
  { id: 240, name: "\u6FEE\u9633" },
  { id: 303, name: "\u6500\u679D\u82B1" },
  { id: 335, name: "\u666E\u6D31" },
  { id: 367, name: "\u5E73\u51C9" },
  { id: 493, name: "\u90B3\u5DDE" },
  { id: 524, name: "\u5E73\u6E56" },
  { id: 546, name: "\u666E\u5B81" },
  { id: 582, name: "\u5E73\u5EA6" },
  { id: 585, name: "\u5F6D\u5DDE" },
  { id: 587, name: "\u84EC\u83B1\u533A" },
  { id: 701, name: "\u9131\u9633" },
  { id: 730, name: "\u6D66\u6C5F" },
  { id: 761, name: "\u78D0\u77F3" },
  { id: 777, name: "\u5E73\u539F" },
  { id: 805, name: "\u5E73\u6F6D" },
  { id: 833, name: "\u6C9B\u53BF" },
  { id: 837, name: "\u84B2\u57CE" },
  { id: 842, name: "\u76D8\u5DDE\u5E02" },
  { id: 847, name: "\u5E73\u6C5F" },
  { id: 849, name: "\u6FEE\u9633\u53BF" },
  { id: 893, name: "\u5E73\u5C71" },
  { id: 923, name: "\u5E73\u6CC9\u5E02" },
  { id: 950, name: "\u5E73\u9091" },
  { id: 960, name: "\u5E73\u8206" },
  { id: 972, name: "\u5E73\u9633" },
  { id: 987, name: "\u5E73\u9065" },
  { id: 991, name: "\u5E73\u679C\u5E02" },
  { id: 1106, name: "\u5E73\u7F57\u53BF" },
  { id: 1156, name: "\u5E73\u9634\u53BF" },
  { id: 1175, name: "\u5E73\u9646\u53BF" },
  { id: 1214, name: "\u5E73\u660C\u53BF" },
  { id: 1226, name: "\u5E73\u5357\u53BF" },
  { id: 1232, name: "\u5F6D\u6C34\u82D7\u65CF\u571F\u5BB6\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1258, name: "\u666E\u5170\u5E97" },
  { id: 1301, name: "\u5E73\u5B9A\u53BF" },
  { id: 60, name: "\u9752\u5C9B" },
  { id: 109, name: "\u9F50\u9F50\u54C8\u5C14" },
  { id: 110, name: "\u6CC9\u5DDE" },
  { id: 122, name: "\u79E6\u7687\u5C9B" },
  { id: 174, name: "\u4E03\u53F0\u6CB3" },
  { id: 189, name: "\u8862\u5DDE" },
  { id: 286, name: "\u6E05\u8FDC" },
  { id: 294, name: "\u94A6\u5DDE" },
  { id: 326, name: "\u9ED4\u897F\u5357" },
  { id: 328, name: "\u9ED4\u4E1C\u5357" },
  { id: 329, name: "\u9ED4\u5357" },
  { id: 330, name: "\u66F2\u9756" },
  { id: 369, name: "\u5E86\u9633" },
  { id: 418, name: "\u743C\u6D77" },
  { id: 430, name: "\u8FC1\u5B89" },
  { id: 496, name: "\u9752\u5DDE" },
  { id: 500, name: "\u542F\u4E1C" },
  { id: 507, name: "\u66F2\u961C" },
  { id: 550, name: "\u6F5C\u6C5F" },
  { id: 644, name: "\u6C81\u9633" },
  { id: 647, name: "\u909B\u5D03" },
  { id: 727, name: "\u9F50\u6CB3" },
  { id: 740, name: "\u6E05\u4E30" },
  { id: 864, name: "\u6DC7\u53BF" },
  { id: 865, name: "\u5168\u6912" },
  { id: 914, name: "\u6816\u971E" },
  { id: 922, name: "\u9752\u7530" },
  { id: 929, name: "\u6E05\u6CB3" },
  { id: 998, name: "\u5E86\u4E91" },
  { id: 1004, name: "\u6F5C\u5C71\u5E02" },
  { id: 1020, name: "\u9752\u53BF" },
  { id: 1089, name: "\u7941\u4E1C\u53BF" },
  { id: 1107, name: "\u5E86\u5B89\u53BF" },
  { id: 1115, name: "\u675E\u53BF" },
  { id: 1131, name: "\u9752\u5188\u53BF" },
  { id: 1139, name: "\u5C90\u5C71\u53BF" },
  { id: 1170, name: "\u743C\u4E2D" },
  { id: 1188, name: "\u7941\u53BF" },
  { id: 1220, name: "\u9752\u9633\u53BF" },
  { id: 1260, name: "\u6E05\u9547" },
  { id: 1265, name: "\u7DA6\u6C5F" },
  { id: 1266, name: "\u6E05\u5F90" },
  { id: 1267, name: "\u8FC1\u897F\u53BF" },
  { id: 1276, name: "\u4F01\u77F3\u9547" },
  { id: 1284, name: "\u9752\u94DC\u5CE1\u5E02" },
  { id: 1287, name: "\u9ED4\u6C5F\u533A" },
  { id: 228, name: "\u65E5\u7167" },
  { id: 348, name: "\u65E5\u5580\u5219" },
  { id: 469, name: "\u745E\u5B89" },
  { id: 475, name: "\u4EC1\u6000" },
  { id: 497, name: "\u8363\u6210" },
  { id: 499, name: "\u4E73\u5C71" },
  { id: 501, name: "\u5982\u768B" },
  { id: 616, name: "\u6C5D\u5DDE" },
  { id: 639, name: "\u745E\u91D1" },
  { id: 657, name: "\u745E\u660C" },
  { id: 749, name: "\u4EC1\u5BFF" },
  { id: 917, name: "\u4EFB\u4E18" },
  { id: 988, name: "\u5982\u4E1C" },
  { id: 1012, name: "\u4EFB\u6CFD\u533A" },
  { id: 1095, name: "\u6C5D\u57CE\u53BF" },
  { id: 1101, name: "\u5BB9\u53BF" },
  { id: 1114, name: "\u8363\u660C\u533A" },
  { id: 1262, name: "\u745E\u4E3D" },
  { id: 66, name: "\u6C88\u9633" },
  { id: 76, name: "\u77F3\u5BB6\u5E84" },
  { id: 80, name: "\u82CF\u5DDE" },
  { id: 111, name: "\u4E09\u4E9A" },
  { id: 117, name: "\u6C55\u5934" },
  { id: 133, name: "\u6714\u5DDE" },
  { id: 162, name: "\u56DB\u5E73" },
  { id: 166, name: "\u677E\u539F" },
  { id: 171, name: "\u53CC\u9E2D\u5C71" },
  { id: 177, name: "\u7EE5\u5316" },
  { id: 184, name: "\u5BBF\u8FC1" },
  { id: 187, name: "\u7ECD\u5174" },
  { id: 201, name: "\u5BBF\u5DDE" },
  { id: 208, name: "\u4E09\u660E" },
  { id: 221, name: "\u4E0A\u9976" },
  { id: 243, name: "\u4E09\u95E8\u5CE1" },
  { id: 245, name: "\u5546\u4E18" },
  { id: 251, name: "\u5341\u5830" },
  { id: 260, name: "\u968F\u5DDE" },
  { id: 266, name: "\u90B5\u9633" },
  { id: 276, name: "\u97F6\u5173" },
  { id: 283, name: "\u6C55\u5C3E" },
  { id: 308, name: "\u9042\u5B81" },
  { id: 347, name: "\u5C71\u5357" },
  { id: 360, name: "\u5546\u6D1B" },
  { id: 383, name: "\u77F3\u5634\u5C71" },
  { id: 406, name: "\u987A\u5FB7" },
  { id: 408, name: "\u77F3\u6CB3\u5B50" },
  { id: 440, name: "\u77F3\u72EE" },
  { id: 456, name: "\u4E0A\u865E" },
  { id: 487, name: "\u795E\u519C\u67B6" },
  { id: 495, name: "\u5BFF\u5149" },
  { id: 530, name: "\u5D4A\u5DDE" },
  { id: 531, name: "\u6CAD\u9633" },
  { id: 532, name: "\u5C04\u9633" },
  { id: 538, name: "\u4E09\u6CB3" },
  { id: 569, name: "\u97F6\u5C71" },
  { id: 613, name: "\u6C99\u6CB3" },
  { id: 633, name: "\u56DB\u4F1A" },
  { id: 648, name: "\u677E\u6ECB" },
  { id: 669, name: "\u8212\u5170" },
  { id: 736, name: "\u90B5\u4E1C\u5E02" },
  { id: 755, name: "\u7762\u53BF" },
  { id: 760, name: "\u6CD7\u9633" },
  { id: 762, name: "\u6C99\u6E7E\u5E02" },
  { id: 768, name: "\u6D89\u53BF" },
  { id: 796, name: "\u795E\u6728\u5E02" },
  { id: 797, name: "\u7EE5\u4E2D" },
  { id: 804, name: "\u4E0A\u9AD8" },
  { id: 819, name: "\u77F3\u6CC9" },
  { id: 824, name: "\u6CD7\u6D2A" },
  { id: 830, name: "\u5355\u53BF" },
  { id: 840, name: "\u6C88\u4E18" },
  { id: 845, name: "\u4E09\u95E8" },
  { id: 875, name: "\u7762\u5B81" },
  { id: 886, name: "\u4E0A\u8521" },
  { id: 895, name: "\u9042\u660C" },
  { id: 907, name: "\u77F3\u5C9B" },
  { id: 953, name: "\u4EC0\u90A1" },
  { id: 955, name: "\u4E0A\u676D" },
  { id: 965, name: "\u5D69\u53BF" },
  { id: 982, name: "\u8212\u57CE" },
  { id: 992, name: "\u5C04\u6D2A\u5E02" },
  { id: 1015, name: "\u5546\u6CB3" },
  { id: 1017, name: "\u6CD7\u6C34" },
  { id: 1022, name: "\u793E\u65D7" },
  { id: 1024, name: "\u6CD7\u53BF" },
  { id: 1039, name: "\u6DF1\u5DDE\u5E02" },
  { id: 1045, name: "\u4E0A\u6797\u53BF" },
  { id: 1055, name: "\u5546\u6C34\u53BF" },
  { id: 1062, name: "\u53CC\u5CF0" },
  { id: 1067, name: "\u9042\u5DDD" },
  { id: 1071, name: "\u4E0A\u6817" },
  { id: 1077, name: "\u838E\u8F66\u53BF" },
  { id: 1081, name: "\u8083\u5B81\u53BF" },
  { id: 1108, name: "\u5546\u57CE\u53BF" },
  { id: 1113, name: "\u6851\u690D" },
  { id: 1118, name: "\u77F3\u95E8" },
  { id: 1120, name: "\u912F\u5584\u53BF" },
  { id: 1155, name: "\u7EE5\u5FB7\u53BF" },
  { id: 1158, name: "\u6C99\u53BF\u533A" },
  { id: 1176, name: "\u6DF1\u6CFD\u53BF" },
  { id: 1180, name: "\u77F3\u67F1" },
  { id: 1189, name: "\u90B5\u6B66" },
  { id: 1192, name: "\u5BFF\u53BF" },
  { id: 1211, name: "\u4E09\u53F0\u53BF" },
  { id: 1228, name: "\u5C71\u4E39\u53BF" },
  { id: 1236, name: "\u9655\u5DDE\u533A" },
  { id: 1240, name: "\u7EE5\u5B81\u53BF" },
  { id: 1249, name: "\u53CC\u57CE" },
  { id: 1250, name: "\u9042\u5E73" },
  { id: 1270, name: "\u5D69\u660E\u53BF" },
  { id: 1272, name: "\u77F3\u6797\u5F5D\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1286, name: "\u8398\u53BF" },
  { id: 1289, name: "\u4E09\u539F\u53BF" },
  { id: 1296, name: "\u53CC\u6CB3\u5E02" },
  { id: 101, name: "\u592A\u539F" },
  { id: 121, name: "\u5510\u5C71" },
  { id: 143, name: "\u901A\u8FBD" },
  { id: 159, name: "\u94C1\u5CAD" },
  { id: 164, name: "\u901A\u5316" },
  { id: 183, name: "\u6CF0\u5DDE" },
  { id: 191, name: "\u53F0\u5DDE" },
  { id: 196, name: "\u94DC\u9675" },
  { id: 226, name: "\u6CF0\u5B89" },
  { id: 325, name: "\u94DC\u4EC1" },
  { id: 352, name: "\u94DC\u5DDD" },
  { id: 364, name: "\u5929\u6C34" },
  { id: 389, name: "\u5410\u9C81\u756A" },
  { id: 399, name: "\u5854\u57CE" },
  { id: 425, name: "\u6850\u4E61" },
  { id: 432, name: "\u592A\u4ED3" },
  { id: 482, name: "\u817E\u51B2" },
  { id: 503, name: "\u53F0\u5C71" },
  { id: 518, name: "\u6CF0\u5174" },
  { id: 549, name: "\u6ED5\u5DDE" },
  { id: 554, name: "\u6850\u5E90" },
  { id: 578, name: "\u5929\u95E8" },
  { id: 626, name: "\u5929\u957F" },
  { id: 666, name: "\u6D2E\u5357" },
  { id: 673, name: "\u6850\u57CE" },
  { id: 743, name: "\u53F0\u524D" },
  { id: 759, name: "\u592A\u548C" },
  { id: 782, name: "\u5929\u53F0" },
  { id: 790, name: "\u592A\u8C37\u533A" },
  { id: 812, name: "\u85E4\u53BF" },
  { id: 817, name: "\u6C64\u9634" },
  { id: 879, name: "\u571F\u9ED8\u7279\u53F3\u65D7" },
  { id: 942, name: "\u90EF\u57CE" },
  { id: 947, name: "\u94DC\u6881" },
  { id: 962, name: "\u540C\u5B89" },
  { id: 1009, name: "\u6843\u6E90" },
  { id: 1030, name: "\u6CF0\u548C\u53BF" },
  { id: 1041, name: "\u94DC\u9F13" },
  { id: 1044, name: "\u7530\u4E1C\u53BF" },
  { id: 1054, name: "\u592A\u5EB7\u53BF" },
  { id: 1111, name: "\u901A\u8BB8\u53BF" },
  { id: 1132, name: "\u901A\u6D77\u53BF" },
  { id: 1135, name: "\u901A\u6986\u53BF" },
  { id: 1136, name: "\u5510\u6CB3" },
  { id: 1154, name: "\u540C\u5FC3\u53BF" },
  { id: 1173, name: "\u5854\u57CE\u5E02" },
  { id: 1215, name: "\u901A\u6C5F\u53BF" },
  { id: 1256, name: "\u5C6F\u660C\u53BF" },
  { id: 1292, name: "\u56FE\u6728\u8212\u514B" },
  { id: 1307, name: "\u94C1\u95E8\u5173\u5E02" },
  { id: 52, name: "\u65E0\u9521" },
  { id: 102, name: "\u829C\u6E56" },
  { id: 112, name: "\u6E29\u5DDE" },
  { id: 141, name: "\u4E4C\u6D77" },
  { id: 147, name: "\u4E4C\u5170\u5BDF\u5E03" },
  { id: 224, name: "\u6F4D\u574A" },
  { id: 227, name: "\u5A01\u6D77" },
  { id: 291, name: "\u68A7\u5DDE" },
  { id: 339, name: "\u6587\u5C71" },
  { id: 355, name: "\u6E2D\u5357" },
  { id: 365, name: "\u6B66\u5A01" },
  { id: 384, name: "\u5434\u5FE0" },
  { id: 387, name: "\u4E4C\u9C81\u6728\u9F50" },
  { id: 428, name: "\u4E07\u5DDE" },
  { id: 433, name: "\u5434\u6C5F" },
  { id: 443, name: "\u6B66\u5937\u5C71" },
  { id: 449, name: "\u6B66\u5B89\u5E02" },
  { id: 457, name: "\u6E29\u5CAD" },
  { id: 479, name: "\u5A7A\u6E90" },
  { id: 498, name: "\u6587\u767B" },
  { id: 551, name: "\u4E4C\u9547" },
  { id: 592, name: "\u5434\u5DDD" },
  { id: 607, name: "\u6587\u660C" },
  { id: 667, name: "\u6B66\u7A74" },
  { id: 680, name: "\u4E07\u5B81" },
  { id: 684, name: "\u821E\u94A2" },
  { id: 696, name: "\u6E29\u53BF" },
  { id: 697, name: "\u6B66\u965F" },
  { id: 747, name: "\u4E4C\u82CF" },
  { id: 769, name: "\u65E0\u4E3A\u5E02" },
  { id: 773, name: "\u6E7E\u6C9A\u533A" },
  { id: 826, name: "\u536B\u8F89" },
  { id: 850, name: "\u4E4C\u62C9\u7279\u524D\u65D7" },
  { id: 897, name: "\u5FAE\u5C71" },
  { id: 898, name: "\u6C76\u4E0A" },
  { id: 904, name: "\u6B66\u57CE" },
  { id: 926, name: "\u56F4\u573A" },
  { id: 967, name: "\u74E6\u623F\u5E97" },
  { id: 973, name: "\u6B66\u4E49" },
  { id: 995, name: "\u6B66\u9E23" },
  { id: 1006, name: "\u5A01\u5B81" },
  { id: 1014, name: "\u821E\u9633" },
  { id: 1019, name: "\u65E0\u6781" },
  { id: 1023, name: "\u4E07\u8363" },
  { id: 1025, name: "\u4E07\u8F7D" },
  { id: 1046, name: "\u5A01\u53BF" },
  { id: 1049, name: "\u6B66\u5E73\u53BF" },
  { id: 1109, name: "\u5C09\u6C0F\u53BF" },
  { id: 1128, name: "\u6B66\u9686\u533A" },
  { id: 1187, name: "\u4E94\u5E38\u5E02" },
  { id: 1207, name: "\u65FA\u82CD\u53BF" },
  { id: 1223, name: "\u6B66\u5188\u5E02" },
  { id: 1255, name: "\u6B66\u5B9A" },
  { id: 1299, name: "\u4E4C\u5170\u6D69\u7279\u5E02" },
  { id: 1302, name: "\u4E94\u5BB6\u6E20\u5E02" },
  { id: 1303, name: "\u4E94\u6307\u5C71\u5E02" },
  { id: 62, name: "\u53A6\u95E8" },
  { id: 103, name: "\u65B0\u4E61" },
  { id: 119, name: "\u5F90\u5DDE" },
  { id: 124, name: "\u90A2\u53F0" },
  { id: 136, name: "\u5FFB\u5DDE" },
  { id: 148, name: "\u5174\u5B89\u76DF" },
  { id: 149, name: "\u9521\u6797\u90ED\u52D2" },
  { id: 206, name: "\u5BA3\u57CE" },
  { id: 215, name: "\u65B0\u4F59" },
  { id: 241, name: "\u8BB8\u660C" },
  { id: 246, name: "\u4FE1\u9633" },
  { id: 253, name: "\u8944\u9633" },
  { id: 256, name: "\u5B5D\u611F" },
  { id: 259, name: "\u54B8\u5B81" },
  { id: 264, name: "\u6E58\u6F6D" },
  { id: 275, name: "\u6E58\u897F" },
  { id: 340, name: "\u897F\u53CC\u7248\u7EB3" },
  { id: 354, name: "\u54B8\u9633" },
  { id: 374, name: "\u897F\u5B81" },
  { id: 412, name: "\u4ED9\u6843" },
  { id: 484, name: "\u9999\u683C\u91CC\u62C9" },
  { id: 517, name: "\u5174\u5316" },
  { id: 523, name: "\u65B0\u6CF0" },
  { id: 525, name: "\u6E58\u9634" },
  { id: 534, name: "\u54CD\u6C34" },
  { id: 543, name: "\u8F9B\u96C6" },
  { id: 548, name: "\u65B0\u6C82" },
  { id: 555, name: "\u65B0\u90D1" },
  { id: 556, name: "\u65B0\u5BC6" },
  { id: 557, name: "\u8365\u9633" },
  { id: 560, name: "\u897F\u5858" },
  { id: 562, name: "\u5174\u5B81" },
  { id: 574, name: "\u65B0\u6C11" },
  { id: 580, name: "\u9879\u57CE" },
  { id: 604, name: "\u5B5D\u4E49" },
  { id: 614, name: "\u6E58\u4E61" },
  { id: 641, name: "\u5174\u57CE" },
  { id: 661, name: "\u5174\u5E73" },
  { id: 692, name: "\u8C61\u5C71" },
  { id: 695, name: "\u4FEE\u6B66" },
  { id: 728, name: "\u590F\u6D25" },
  { id: 729, name: "\u4FE1\u5B9C" },
  { id: 734, name: "\u65B0\u5316" },
  { id: 764, name: "\u4ED9\u5C45" },
  { id: 776, name: "\u8944\u57A3" },
  { id: 802, name: "\u5BA3\u5A01" },
  { id: 810, name: "\u971E\u6D66" },
  { id: 818, name: "\u65B0\u5B89" },
  { id: 828, name: "\u65B0\u4E61\u53BF" },
  { id: 843, name: "\u76F1\u7719" },
  { id: 853, name: "\u5F90\u95FB" },
  { id: 857, name: "\u590F\u9091" },
  { id: 863, name: "\u6D5A\u53BF" },
  { id: 870, name: "\u897F\u4E61" },
  { id: 885, name: "\u897F\u5E73" },
  { id: 892, name: "\u65B0\u4E50" },
  { id: 903, name: "\u65B0\u660C" },
  { id: 920, name: "\u859B\u57CE" },
  { id: 936, name: "\u897F\u534E" },
  { id: 949, name: "\u6D60\u6C34" },
  { id: 957, name: "\u9999\u6CB3" },
  { id: 959, name: "\u4FE1\u4E30" },
  { id: 961, name: "\u65B0\u8521" },
  { id: 996, name: "\u6E86\u6D66" },
  { id: 1021, name: "\u6DC5\u5DDD" },
  { id: 1026, name: "\u65B0\u5E72" },
  { id: 1033, name: "\u5174\u56FD\u53BF" },
  { id: 1036, name: "\u65B0\u7530" },
  { id: 1050, name: "\u5BFB\u4E4C\u53BF" },
  { id: 1051, name: "\u7965\u4E91\u53BF" },
  { id: 1057, name: "\u8944\u57CE\u53BF" },
  { id: 1063, name: "\u65B0\u5B81" },
  { id: 1082, name: "\u732E\u53BF" },
  { id: 1123, name: "\u65B0\u6D32\u533A" },
  { id: 1129, name: "\u79C0\u5C71\u571F\u5BB6\u65CF\u82D7\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1137, name: "\u65B0\u91CE" },
  { id: 1149, name: "\u4ED9\u6E38\u53BF" },
  { id: 1167, name: "\u65B0\u6D25\u533A" },
  { id: 1213, name: "\u65EC\u9633\u5E02" },
  { id: 1244, name: "\u5B5D\u660C\u53BF" },
  { id: 1248, name: "\u606F\u53BF" },
  { id: 1261, name: "\u8427\u53BF" },
  { id: 1277, name: "\u8C22\u5C97\u9547" },
  { id: 1294, name: "\u5174\u4E49\u5E02" },
  { id: 1309, name: "\u96C4\u5B89\u65B0\u533A" },
  { id: 104, name: "\u70DF\u53F0" },
  { id: 120, name: "\u626C\u5DDE" },
  { id: 130, name: "\u9633\u6CC9" },
  { id: 135, name: "\u8FD0\u57CE" },
  { id: 155, name: "\u8425\u53E3" },
  { id: 168, name: "\u5EF6\u8FB9" },
  { id: 172, name: "\u4F0A\u6625" },
  { id: 181, name: "\u76D0\u57CE" },
  { id: 216, name: "\u9E70\u6F6D" },
  { id: 219, name: "\u5B9C\u6625" },
  { id: 252, name: "\u5B9C\u660C" },
  { id: 267, name: "\u5CB3\u9633" },
  { id: 270, name: "\u76CA\u9633" },
  { id: 272, name: "\u6C38\u5DDE" },
  { id: 285, name: "\u9633\u6C5F" },
  { id: 289, name: "\u4E91\u6D6E" },
  { id: 296, name: "\u7389\u6797" },
  { id: 313, name: "\u5B9C\u5BBE" },
  { id: 316, name: "\u96C5\u5B89" },
  { id: 331, name: "\u7389\u6EAA" },
  { id: 356, name: "\u5EF6\u5B89" },
  { id: 358, name: "\u6986\u6797" },
  { id: 380, name: "\u7389\u6811" },
  { id: 382, name: "\u94F6\u5DDD" },
  { id: 398, name: "\u4F0A\u7281" },
  { id: 405, name: "\u4E49\u4E4C" },
  { id: 453, name: "\u5156\u5DDE" },
  { id: 454, name: "\u5B9C\u5174" },
  { id: 458, name: "\u6C38\u5EB7" },
  { id: 459, name: "\u4F59\u59DA" },
  { id: 466, name: "\u9633\u6714" },
  { id: 470, name: "\u4E50\u6E05" },
  { id: 514, name: "\u82F1\u5FB7" },
  { id: 516, name: "\u4F0A\u5DDD" },
  { id: 522, name: "\u4EEA\u5F81" },
  { id: 528, name: "\u5043\u5E08\u533A" },
  { id: 559, name: "\u626C\u4E2D" },
  { id: 577, name: "\u6C38\u57CE" },
  { id: 597, name: "\u6C38\u6D4E" },
  { id: 608, name: "\u79B9\u57CE" },
  { id: 609, name: "\u79B9\u5DDE" },
  { id: 622, name: "\u4F0A\u5B81" },
  { id: 625, name: "\u5B9C\u57CE" },
  { id: 637, name: "\u539F\u5E73" },
  { id: 656, name: "\u5B9C\u90FD" },
  { id: 658, name: "\u6C85\u6C5F" },
  { id: 693, name: "\u7389\u73AF\u5E02" },
  { id: 733, name: "\u6C38\u5DDD" },
  { id: 763, name: "\u6C38\u5E74" },
  { id: 770, name: "\u9633\u57CE" },
  { id: 778, name: "\u4E91\u9633" },
  { id: 784, name: "\u53F6\u53BF" },
  { id: 803, name: "\u6613\u53BF" },
  { id: 814, name: "\u5B9C\u9633" },
  { id: 822, name: "\u960E\u826F" },
  { id: 829, name: "\u539F\u9633" },
  { id: 859, name: "\u865E\u57CE" },
  { id: 876, name: "\u7389\u5C71" },
  { id: 878, name: "\u9633\u8C37" },
  { id: 884, name: "\u90D3\u57CE" },
  { id: 901, name: "\u4F0A\u91D1\u970D\u6D1B\u65D7" },
  { id: 908, name: "\u6768\u9675" },
  { id: 940, name: "\u6C82\u6C34" },
  { id: 943, name: "\u6C82\u5357" },
  { id: 958, name: "\u4E8E\u90FD" },
  { id: 1027, name: "\u5B9C\u4E30" },
  { id: 1043, name: "\u8425\u5C71\u53BF" },
  { id: 1047, name: "\u6C38\u5B89" },
  { id: 1058, name: "\u9122\u9675" },
  { id: 1069, name: "\u6C38\u4E30" },
  { id: 1072, name: "\u6C38\u65B0" },
  { id: 1094, name: "\u6C38\u5174\u53BF" },
  { id: 1096, name: "\u6538\u53BF" },
  { id: 1099, name: "\u6C38\u987A\u53BF" },
  { id: 1117, name: "\u88D5\u6C11\u53BF" },
  { id: 1127, name: "\u9149\u9633\u571F\u5BB6\u65CF\u82D7\u65CF\u81EA\u6CBB\u53BF" },
  { id: 1151, name: "\u5E94\u53BF" },
  { id: 1159, name: "\u9633\u5C71\u53BF" },
  { id: 1160, name: "\u6986\u6811\u5E02" },
  { id: 1162, name: "\u6C85\u9675\u53BF" },
  { id: 1169, name: "\u6C38\u767B\u53BF" },
  { id: 1181, name: "\u9C7C\u53F0\u53BF" },
  { id: 1182, name: "\u5B9C\u5DDE\u533A" },
  { id: 1186, name: "\u4E49\u9A6C\u5E02" },
  { id: 1198, name: "\u6C38\u5609\u53BF" },
  { id: 1199, name: "\u76C2\u53BF" },
  { id: 1218, name: "\u5B9C\u826F\u53BF" },
  { id: 1273, name: "\u7389\u7530\u53BF" },
  { id: 1282, name: "\u6C38\u5B81\u53BF" },
  { id: 1308, name: "\u988D\u4E0A\u53BF" },
  { id: 73, name: "\u90D1\u5DDE" },
  { id: 81, name: "\u6DC4\u535A" },
  { id: 108, name: "\u73E0\u6D77" },
  { id: 113, name: "\u4E2D\u5C71" },
  { id: 125, name: "\u5F20\u5BB6\u53E3" },
  { id: 182, name: "\u9547\u6C5F" },
  { id: 190, name: "\u821F\u5C71" },
  { id: 209, name: "\u6F33\u5DDE" },
  { id: 222, name: "\u67A3\u5E84" },
  { id: 247, name: "\u5468\u53E3" },
  { id: 248, name: "\u9A7B\u9A6C\u5E97" },
  { id: 263, name: "\u682A\u6D32" },
  { id: 269, name: "\u5F20\u5BB6\u754C" },
  { id: 278, name: "\u6E5B\u6C5F" },
  { id: 280, name: "\u8087\u5E86" },
  { id: 302, name: "\u81EA\u8D21" },
  { id: 318, name: "\u8D44\u9633" },
  { id: 323, name: "\u9075\u4E49" },
  { id: 333, name: "\u662D\u901A" },
  { id: 366, name: "\u5F20\u6396" },
  { id: 386, name: "\u4E2D\u536B" },
  { id: 419, name: "\u5F20\u5BB6\u6E2F" },
  { id: 426, name: "\u6DBF\u5DDE" },
  { id: 465, name: "\u7AE0\u4E18\u533A" },
  { id: 468, name: "\u8BF8\u66A8" },
  { id: 494, name: "\u67A3\u9633" },
  { id: 508, name: "\u90B9\u5E73" },
  { id: 526, name: "\u8BF8\u57CE" },
  { id: 558, name: "\u5E84\u6CB3" },
  { id: 586, name: "\u62DB\u8FDC" },
  { id: 591, name: "\u9075\u5316" },
  { id: 612, name: "\u949F\u7965" },
  { id: 615, name: "\u5468\u5E84" },
  { id: 654, name: "\u679D\u6C5F" },
  { id: 663, name: "\u6F33\u6D66" },
  { id: 671, name: "\u6A1F\u6811" },
  { id: 757, name: "\u6B63\u5B9A" },
  { id: 821, name: "\u4E2D\u725F" },
  { id: 834, name: "\u90B9\u57CE" },
  { id: 841, name: "\u8D75\u53BF" },
  { id: 858, name: "\u67D8\u57CE" },
  { id: 891, name: "\u51C6\u683C\u5C14\u65D7" },
  { id: 985, name: "\u5468\u81F3" },
  { id: 997, name: "\u82B7\u6C5F" },
  { id: 1007, name: "\u7EC7\u91D1" },
  { id: 1048, name: "\u6F33\u5E73" },
  { id: 1093, name: "\u8D44\u5174\u5E02" },
  { id: 1140, name: "\u624E\u5170\u5C6F\u5E02" },
  { id: 1179, name: "\u5FE0\u53BF" },
  { id: 1196, name: "\u67D8\u8363" },
  { id: 1200, name: "\u4E2D\u6C5F\u53BF" },
  { id: 1246, name: "\u9547\u96C4\u53BF" },
  { id: 1259, name: "\u4E2D\u5B81\u53BF" }
];

// src/maoyan/api.js
var MAOYAN_API = "https://m.maoyan.com/ajax/cinemaDetail?cinemaId=";
var COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Referer: "https://m.maoyan.com/"
};
function mergeCookies(jar, setCookieList) {
  for (const raw of setCookieList || []) {
    const pair = raw.split(";")[0];
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const rest = jar.filter((c) => c.split("=")[0].trim() !== name);
    rest.push(pair);
    jar.length = 0;
    jar.push(...rest);
  }
}
__name(mergeCookies, "mergeCookies");
async function fetchWithJar(url, jar) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const headers = { ...COMMON_HEADERS };
    if (jar.length) headers.Cookie = jar.join("; ");
    const res = await fetch(current, { headers, redirect: "manual", cf: { cacheTtl: 0 } });
    mergeCookies(jar, res.headers.getSetCookie?.() || []);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  throw new Error("\u91CD\u5B9A\u5411\u8D85\u8FC7 5 \u6B21");
}
__name(fetchWithJar, "fetchWithJar");
async function fetchCinemaDetail(cinemaId) {
  const jar = [];
  await fetchWithJar("https://m.maoyan.com/", jar);
  const res = await fetchWithJar(MAOYAN_API + cinemaId, jar);
  const data = JSON.parse(await res.text());
  if (!data || !data.showData || !Array.isArray(data.showData.movies)) {
    throw new Error("\u63A5\u53E3\u6570\u636E\u5F02\u5E38(\u7F3A\u5C11 showData.movies)");
  }
  return data;
}
__name(fetchCinemaDetail, "fetchCinemaDetail");
function parseCinemasHTML(html) {
  const cinemas = [];
  const re = /<a href="\/shows\/(\d+)"[\s\S]*?data-id="\d+" data-bid="dp_wx_home_cinema_list">[\s\S]*?<span>([^<]*)<\/span>[\s\S]*?line-ellipsis">([^<]*)</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    cinemas.push({ id: m[1], nm: m[2], addr: m[3].trim() });
  }
  return cinemas;
}
__name(parseCinemasHTML, "parseCinemasHTML");
async function fetchCinemaPage(cityId, jar, offset, limit) {
  const params = new URLSearchParams({
    day: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    offset: String(offset),
    limit: String(limit),
    districtId: "-1",
    lineId: "-1",
    hallType: "-1",
    brandId: "-1",
    serviceId: "-1",
    areaId: "-1",
    stationId: "-1",
    item: "",
    updateShowDay: "true",
    reqId: String(Date.now()),
    cityId: String(cityId)
  });
  const res = await fetchWithJar("https://m.maoyan.com/ajax/moreCinemas?" + params.toString(), jar);
  const text = await res.text();
  if (!text || text.trim().startsWith("<!DOCTYPE")) {
    throw new Error("\u732B\u773C\u8FD4\u56DE\u5F02\u5E38\u9875\u9762");
  }
  return parseCinemasHTML(text);
}
__name(fetchCinemaPage, "fetchCinemaPage");
async function searchCinemasByKw(env, cityId, kw) {
  const cacheKey = `cache:cinemas:${cityId}`;
  const cached = await env.MAOYAN_KV.get(cacheKey, "json");
  let all = Array.isArray(cached) ? cached : null;
  if (!all) {
    const jar = [];
    await fetchWithJar("https://m.maoyan.com/", jar);
    all = [];
    for (let offset = 0; offset < 1e3; offset += 100) {
      const page = await fetchCinemaPage(cityId, jar, offset, 100);
      all.push(...page);
      if (page.length < 100) break;
    }
    if (all.length) {
      await env.MAOYAN_KV.put(cacheKey, JSON.stringify(all), { expirationTtl: 6 * 3600 });
    }
  }
  const q = String(kw).toLowerCase();
  return all.filter(
    (c) => c.nm.toLowerCase().includes(q) || (c.addr || "").toLowerCase().includes(q)
  );
}
__name(searchCinemasByKw, "searchCinemasByKw");

// src/maoyan/push.js
async function pushBark(barkKey, title, content) {
  let base = String(barkKey || "").trim();
  if (!base) throw new Error("Bark \u672A\u914D\u7F6E");
  if (!/^https?:\/\//i.test(base)) base = "https://api.day.app/" + base;
  base = base.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(content)}?group=maoyan`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error("Bark \u63A8\u9001\u5931\u8D25: HTTP " + res.status);
}
__name(pushBark, "pushBark");

// src/maoyan/check.js
function fmtShow(s) {
  const parts = [`${s.dt || ""} ${s.tm || ""}`, s.lang || "", s.tp || "", s.th || ""];
  if (s.vipPrice) parts.push(`\xA5${s.vipPrice}${s.vipPriceSuffix || ""}`);
  return parts.filter(Boolean).join(" | ");
}
__name(fmtShow, "fmtShow");
async function runCheck(env, manual, token) {
  const cfg = await getUserConfig(env, token);
  if (!cfg.cinemaId) return { ok: false, error: "\u672A\u914D\u7F6E\u5F71\u9662" };
  if (cfg.enabled === false) {
    return manual ? { ok: false, error: "\u76D1\u63A7\u5DF2\u505C\u6B62\uFF0C\u8BF7\u5148\u5728\u754C\u9762\u6062\u590D\u76D1\u63A7" } : { ok: true, skipped: true, stopped: true };
  }
  const selected = new Set((cfg.selectedMovieIds || []).map(String));
  const stKey = userKey(token, "status");
  const st = await env.MAOYAN_KV.get(stKey, "json") || {};
  const now = Date.now();
  const intervalMs = Math.max(1, Number(cfg.intervalMinutes) || 10) * 60 * 1e3;
  if (!manual && st.lastCheckTs && now - st.lastCheckTs < intervalMs * 0.9) {
    return { ok: true, skipped: true };
  }
  const data = await fetchCinemaDetail(cfg.cinemaId);
  const cinemaName = data.showData.cinemaName || "";
  const snapKey = userKey(token, "snapshot");
  const chKey = userKey(token, "changes");
  const snapshot = await env.MAOYAN_KV.get(snapKey, "json") || {};
  const changes = await env.MAOYAN_KV.get(chKey, "json") || [];
  let newTotal = 0;
  for (const movie of data.showData.movies || []) {
    const idStr = String(movie.id);
    const shows = [];
    for (const day of movie.shows || []) for (const p of day.plist || []) shows.push(p);
    const isFirst = !Object.prototype.hasOwnProperty.call(snapshot, idStr);
    const prev = new Set(snapshot[idStr] || []);
    const added = shows.filter((s) => !prev.has(s.seqNo));
    if (selected.has(idStr) && !isFirst && added.length > 0) {
      newTotal += added.length;
      const lines = added.slice(0, 20).map(fmtShow);
      if (added.length > 20) lines.push(`...\u7B49\u5171 ${added.length} \u573A`);
      const title = `\u{1F3AC}\u65B0\u589E\u573A\u6B21: ${movie.nm}`;
      const content = `\u3010${cinemaName}\u3011
${lines.join("\n")}`;
      changes.unshift({ time: (/* @__PURE__ */ new Date()).toISOString(), type: "new", text: `\u65B0\u589E ${added.length} \u573A\u300A${movie.nm}\u300B: ${lines[0]}` });
      try {
        await pushBark(cfg.barkKey, title, content);
        changes.unshift({ time: (/* @__PURE__ */ new Date()).toISOString(), type: "ok", text: `\u5DF2\u63A8\u9001 Bark(${movie.nm}, ${added.length} \u573A)` });
      } catch (e) {
        changes.unshift({ time: (/* @__PURE__ */ new Date()).toISOString(), type: "error", text: "Bark \u63A8\u9001\u5931\u8D25: " + e.message });
      }
    }
    snapshot[idStr] = shows.map((s) => s.seqNo);
  }
  while (changes.length > 100) changes.pop();
  await env.MAOYAN_KV.put(snapKey, JSON.stringify(snapshot));
  await env.MAOYAN_KV.put(chKey, JSON.stringify(changes));
  await env.MAOYAN_KV.put(
    stKey,
    JSON.stringify({ lastCheckTs: now, lastCheck: (/* @__PURE__ */ new Date()).toISOString(), cinemaName, newTotal, enabled: cfg.enabled !== false })
  );
  return { ok: true, cinemaName, newTotal, enabled: cfg.enabled !== false };
}
__name(runCheck, "runCheck");

// src/maoyan/tokens.js
function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomToken, "randomToken");
async function getManagedTokens(env) {
  return await env.MAOYAN_KV.get("meta:tokens", "json") || [];
}
__name(getManagedTokens, "getManagedTokens");
async function saveManagedTokens(env, list) {
  await env.MAOYAN_KV.put("meta:tokens", JSON.stringify(list));
  await env.MAOYAN_KV.put("meta:cron_tokens", JSON.stringify(list.map((t) => t.token).filter(Boolean)));
}
__name(saveManagedTokens, "saveManagedTokens");
async function markTokenUsed(env, token) {
  try {
    const now = Date.now();
    const list = await getManagedTokens(env);
    const i = list.findIndex((t) => t.token === token);
    if (i >= 0) {
      const last = Date.parse(list[i].lastUsedAt || "") || 0;
      if (now - last < 24 * 3600 * 1e3) return;
      list[i].lastUsedAt = new Date(now).toISOString();
      await env.MAOYAN_KV.put("meta:tokens", JSON.stringify(list));
    }
  } catch (e) {
  }
}
__name(markTokenUsed, "markTokenUsed");
function checkAdminAuth(request, env) {
  const admin = String(env.ADMIN_TOKEN || "").trim();
  if (!admin) return false;
  const given = request.headers.get("X-Admin-Token") || "";
  return given === admin;
}
__name(checkAdminAuth, "checkAdminAuth");
async function checkAuthFull(request, env, url) {
  const given = request.headers.get("X-Token") || "";
  const managed = await getManagedTokens(env);
  if (!managed.length) return null;
  const hit = managed.find((t) => t.token === given);
  if (hit) {
    markTokenUsed(env, given);
    return given;
  }
  return null;
}
__name(checkAuthFull, "checkAuthFull");
async function syncCronTokens(env) {
  try {
    const managed = await getManagedTokens(env);
    const list = managed.map((t) => t.token).filter(Boolean);
    const key = "meta:cron_tokens";
    const prev = await env.MAOYAN_KV.get(key, "json");
    if (JSON.stringify(prev) !== JSON.stringify(list)) {
      await env.MAOYAN_KV.put(key, JSON.stringify(list));
    }
  } catch (e) {
  }
}
__name(syncCronTokens, "syncCronTokens");
async function runScheduledChecks(env) {
  let list = null;
  try {
    const meta = await env.MAOYAN_KV.get("meta:cron_tokens", "json");
    if (Array.isArray(meta)) list = meta.filter(Boolean);
  } catch (e) {
  }
  if (list === null) list = [];
  if (!list.length) return;
  for (const token of list) {
    try {
      await runCheck(env, false, token);
    } catch (e) {
    }
  }
}
__name(runScheduledChecks, "runScheduledChecks");
async function handleAdminTokens(request, env, url) {
  if (!checkAdminAuth(request, env)) {
    return json({ error: "\u7BA1\u7406\u4EE4\u724C\u9519\u8BEF\u6216\u672A\u914D\u7F6E ADMIN_TOKEN" }, 401);
  }
  try {
    if (request.method === "GET") {
      const managed = await getManagedTokens(env);
      const tokens = managed.map((t) => ({
        token: t.token,
        remark: t.remark || "",
        inUse: Boolean(t.lastUsedAt),
        createdAt: t.createdAt || null,
        lastUsedAt: t.lastUsedAt || null
      }));
      return json({ ok: true, tokens });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const token = String(body.token || "").trim() || randomToken();
      if (!/^[\x21-\x7e]{6,64}$/.test(token)) {
        return json({ ok: false, error: "\u4EE4\u724C\u987B\u4E3A 6-64 \u4F4D\u53EF\u89C1 ASCII \u5B57\u7B26" }, 400);
      }
      const list = await getManagedTokens(env);
      if (list.some((t) => t.token === token)) {
        return json({ ok: false, error: "\u4EE4\u724C\u5DF2\u5B58\u5728" }, 400);
      }
      list.push({ token, remark: String(body.remark || "").slice(0, 50), createdAt: (/* @__PURE__ */ new Date()).toISOString(), lastUsedAt: null });
      await saveManagedTokens(env, list);
      return json({ ok: true, token });
    }
    if (request.method === "DELETE") {
      const token = url.searchParams.get("token") || "";
      const list = await getManagedTokens(env);
      const next = list.filter((t) => t.token !== token);
      if (next.length === list.length) {
        return json({ ok: false, error: "\u4EE4\u724C\u4E0D\u5B58\u5728" }, 404);
      }
      await saveManagedTokens(env, next);
      await cleanupUserData(env, token);
      return json({ ok: true });
    }
    return json({ error: "Method Not Allowed" }, 405);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
__name(handleAdminTokens, "handleAdminTokens");

// src/store/proxy.js
var STORE_UPSTREAM = "http://appstore.cnmlynk.org";
async function handleStoreApi(request, url) {
  try {
    const sub = url.pathname.slice("/store/api".length);
    const init = { method: request.method, headers: { "Content-Type": "application/json" } };
    if (request.method === "POST") init.body = await request.text();
    const res = await fetch(STORE_UPSTREAM + "/api" + sub, init);
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/json; charset=utf-8", ...CORS }
    });
  } catch (e) {
    return json({ ok: false, error: "AList \u53CD\u4EE3\u5931\u8D25: " + e.message }, 502);
  }
}
__name(handleStoreApi, "handleStoreApi");
var FILE_PROXY_ALLOWED_HOSTS = /* @__PURE__ */ new Set(["appstore.cnmlynk.org"]);
async function handleStoreFile(url) {
  const fileUrl = url.searchParams.get("url") || "";
  let target;
  try {
    target = new URL(fileUrl);
  } catch (e) {
    return json({ error: "\u65E0\u6548\u7684 url \u53C2\u6570" }, 400);
  }
  if (target.protocol !== "http:" || !FILE_PROXY_ALLOWED_HOSTS.has(target.hostname)) {
    return json({ error: "\u4EC5\u652F\u6301\u4EE3\u7406\u4E0A\u6E38 AList \u57DF\u540D\u7684 http \u76F4\u94FE" }, 403);
  }
  try {
    const res = await fetch(fileUrl, { redirect: "follow" });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": res.headers.get("content-disposition") || "",
        ...CORS
      }
    });
  } catch (e) {
    return json({ ok: false, error: "\u6587\u4EF6\u4EE3\u7406\u5931\u8D25: " + e.message }, 502);
  }
}
__name(handleStoreFile, "handleStoreFile");

// src/index.js
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname.startsWith("/store/api/")) return handleStoreApi(request, url);
    if (url.pathname === "/store/file") return handleStoreFile(url);
    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "Not Found" }, 404);
    }
    if (url.pathname === "/api/admin/tokens") return handleAdminTokens(request, env, url);
    const token = await checkAuthFull(request, env, url);
    if (token === null) return json({ error: "\u8BBF\u95EE\u4EE4\u724C\u9519\u8BEF" }, 401);
    await syncCronTokens(env);
    try {
      if (url.pathname === "/api/cities") {
        return json({ ok: true, cities: CITY_LIST });
      }
      if (url.pathname === "/api/cinemas") {
        const cityId = (url.searchParams.get("cityId") || "").trim();
        const kw = (url.searchParams.get("kw") || "").trim();
        if (!cityId) return json({ ok: false, error: "\u7F3A\u5C11 cityId" }, 400);
        if (!kw) return json({ ok: false, error: "\u7F3A\u5C11 kw" }, 400);
        const cinemas = await searchCinemasByKw(env, cityId, kw);
        return json({ ok: true, cinemas });
      }
      if (url.pathname === "/api/shows") {
        const cfg = await getUserConfig(env, token);
        const cinemaId = (url.searchParams.get("cinemaId") || "").trim() || cfg.cinemaId;
        if (!cinemaId) return json({ ok: false, error: "\u7F3A\u5C11 cinemaId" });
        const data = await fetchCinemaDetail(cinemaId);
        return json({
          ok: true,
          cinemaId,
          cinemaName: data.showData.cinemaName,
          movies: (data.showData.movies || []).map((m) => ({
            id: m.id,
            nm: m.nm,
            showCount: m.showCount,
            shows: (m.shows || []).map((d) => ({
              showDate: d.showDate || d.dt || "",
              plist: (d.plist || []).map((p) => ({
                tm: p.tm,
                lang: p.lang,
                tp: p.tp,
                th: p.th,
                vipPrice: p.vipPrice,
                vipPriceSuffix: p.vipPriceSuffix,
                ticketStatus: p.ticketStatus
              }))
            }))
          }))
        });
      }
      if (url.pathname === "/api/config" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        return json({ ok: true, config: { enabled: cfg.enabled !== false, ...cfg } });
      }
      if (url.pathname === "/api/config" && request.method === "POST") {
        const body = await request.json();
        const key = userKey(token, "config");
        const cfg = await env.MAOYAN_KV.get(key, "json") || await getUserConfig(env, token);
        if (body.enabled !== void 0) cfg.enabled = Boolean(body.enabled);
        if (body.cinemaId !== void 0) cfg.cinemaId = String(body.cinemaId).trim();
        if (body.selectedMovieIds !== void 0) cfg.selectedMovieIds = (body.selectedMovieIds || []).map(String);
        if (body.intervalMinutes !== void 0) cfg.intervalMinutes = Math.max(1, parseInt(body.intervalMinutes, 10) || 10);
        if (body.barkKey !== void 0) cfg.barkKey = String(body.barkKey).trim();
        if (body.enabled === void 0 && body.cinemaId !== void 0) cfg.enabled = true;
        await env.MAOYAN_KV.put(key, JSON.stringify(cfg));
        return json({ ok: true, config: { enabled: cfg.enabled !== false, ...cfg } });
      }
      if (url.pathname === "/api/check" && request.method === "POST") {
        return json(await runCheck(env, true, token));
      }
      if (url.pathname === "/api/test-bark" && request.method === "POST") {
        const cfg = await getUserConfig(env, token);
        await pushBark(cfg.barkKey, "\u732B\u773C\u573A\u6B21\u76D1\u63A7", "\u8FD9\u662F\u4E00\u6761\u6D4B\u8BD5\u63A8\u9001, \u4E91\u7AEF Bark \u914D\u7F6E\u6210\u529F \u2705");
        return json({ ok: true });
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        const cfg = await getUserConfig(env, token);
        const st = await env.MAOYAN_KV.get(userKey(token, "status"), "json") || {};
        const status = {
          lastCheckTs: st.lastCheckTs,
          lastCheck: st.lastCheck,
          cinemaName: st.cinemaName,
          newTotal: st.newTotal,
          enabled: cfg.enabled !== false
        };
        const changes = await env.MAOYAN_KV.get(userKey(token, "changes"), "json") || [];
        return json({ ok: true, authMode: "token", status, changes });
      }
      return json({ error: "Unknown API" }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  },
  async scheduled(event, env) {
    await runScheduledChecks(env);
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
