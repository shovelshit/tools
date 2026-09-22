import test from "node:test";
import assert from "node:assert/strict";
import { captureConsole } from "./helpers.js";
import { sanitizeFailureText } from "../src/maoyan/failure-detail.js";
import {
  createUnpaidOrder,
  extractOfficialSeatHtml,
  fetchSeatMap,
  findCompatibleShows,
  findExactShows,
  OrderAttemptError,
  parseSeatPage,
  requestMaoyan,
  seatDisplayLabel,
  seatSegmentOf
} from "../src/maoyan/lock-client.js";

const seatHtml = `
  <div class="seats-block" data-section-id="88" data-section-name="1号厅 &amp; 特效" data-seq-no="2026091201">
    <span class="seat selectable" data-row-id="6" data-column-id="18" data-no="1-6-18" data-st="N"></span>
    <span class="seat sold" data-row-id="6" data-column-id="19" data-no="1-6-19" data-st="N"></span>
  </div>`;

const session = {
  cookies: [
    { name: "uid", value: "test-user" },
    { name: "token", value: "test-cookie" }
  ],
  csrf: "test-csrf",
  mtgsig: "test-signature",
  userAgent: "Test Agent/1.0",
  createOrderQuery: {
    yodaReady: "h5",
    csecplatform: "4",
    csecversion: "4.3.0"
  }
};

test("shared failure sanitizer preserves provider reason while stripping configured credentials", () => {
  const detail = sanitizeFailureText("HTTP 403 provider rejected notify-key https://notify.example/notify-key token=unknown-secret", ["notify-key"]);
  assert.match(detail, /HTTP 403 provider rejected/);
  assert.doesNotMatch(detail, /notify-key|notify.example|unknown-secret/);
  assert.ok(new TextEncoder().encode(sanitizeFailureText("座".repeat(7000))).length <= 16384);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("order request preserves uid.sig in the cookie header", async () => {
  const signedSession = {
    ...session,
    cookies: [...session.cookies, { name: "uid.sig", value: "test-uid-signature" }]
  };
  await withMockFetch(async (_url, init) => {
    assert.match(init.headers.Cookie, /(?:^|; )uid\.sig=test-uid-signature(?:;|$)/);
    return jsonResponse({ data: { data: { id: "order-signed", payLeftSecond: 600 } } });
  }, async () => {
    assert.equal((await createUnpaidOrder(signedSession, parseSeatPage(seatHtml), ["1-6-18"])).orderId, "order-signed");
  });
});

test("empty order IDs and unsuccessful HTTP responses are not successful orders", async () => {
  for (const [id, status] of [["", 200], ["   ", 200], [0, 200], ["order-1", 502]]) {
    await withMockFetch(async () => jsonResponse({ data: { data: { id } } }, status), async () => {
      await assert.rejects(
        () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
        /锁座失败/
      );
    });
  }
});

async function withMockFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

test("parses available and unavailable seats without losing layout", () => {
  const map = parseSeatPage(seatHtml);
  assert.equal(map.sectionId, "88");
  assert.equal(map.sectionName, "1号厅 & 特效");
  assert.equal(map.seqNo, "2026091201");
  // cols: 无 data-cols 的旧页为 0; orderIndex: 排内 DOM 位次(含过道占位符计数)
  assert.equal(map.cols, 0);
  assert.deepEqual(map.seats, [
    { rowId: "6", columnId: "18", seatNo: "1-6-18", type: "N", available: true, availability: "available", disabledReason: null, orderIndex: 1 },
    { rowId: "6", columnId: "19", seatNo: "1-6-19", type: "N", available: false, availability: "sold", disabledReason: "已售", orderIndex: 2 }
  ]);
});

test("sold class overrides selectable and a disabled seat is not mislabeled sold", () => {
  const map = parseSeatPage(`<div class="seats-block" data-section-id="1" data-section-name="A" data-seq-no="9">
    <span class="seat sold selectable" data-row-id="1" data-column-id="1" data-no="1-1-1" data-st="N"></span>
    <span class="seat disabled" data-row-id="1" data-column-id="2" data-no="1-1-2" data-st="N"></span>
    <span class="seat" data-row-id="1" data-column-id="3" data-no="1-1-3" data-st="N"></span>
  </div>`);
  assert.deepEqual(map.seats.map((seat) => [seat.availability, seat.available]), [
    ["sold", false], ["unavailable", false], ["unknown", false]
  ]);
});

test("seat map omits official HTML unless explicitly requested", async () => {
  await withMockFetch(async () => new Response(seatHtml), async () => {
    const normal = await fetchSeatMap(session, { cinemaId: "25428", movieId: "7", seqNo: "2026091201" });
    assert.equal(Object.hasOwn(normal, "officialHtml"), false);
    const withOfficial = await fetchSeatMap(session, { cinemaId: "25428", movieId: "7", seqNo: "2026091201", includeOfficial: true });
    assert.match(withOfficial.officialHtml, /seats-block/);
  });
});

test("keeps aisle placeholders in orderIndex and parses data-cols (HuanYing IMAX real layout)", () => {  // 真实原页锚定(寰映影城 1号激光IMAX厅, 2026-09-14): 每排 37 物理格(data-cols),
  // 过道由 data-st="E" 空占位符占据(无 data-no/column-id); DOM 顺序即物理从左到右,
  // 座位列号降序(座 29 最左)。排1 = 4 占位 + 座29..1 + 4 占位; 排10 左端孤立座 33。
  // 前端按 orderIndex 复现主站居中/孤立座布局; 占位符本体不进 seats(不可选不可下单)。
  const html = `<div class="seats-block" data-section-id="1" data-section-name="普通区" data-seq-no="202609140012244" data-cols="37">
    <div class="row">
      <span class="seat empty" data-column-id="" data-row-id="1" data-no="" data-st="E"></span>
      <span class="seat empty" data-column-id="" data-row-id="1" data-no="" data-st="E"></span>
      <span class="seat empty" data-column-id="" data-row-id="1" data-no="" data-st="E"></span>
      <span class="seat empty" data-column-id="" data-row-id="1" data-no="" data-st="E"></span>
      <span class="seat sold" data-column-id="29" data-row-id="1" data-no="33-1-29" data-st="LK"></span>
      <span class="seat selectable" data-column-id="28" data-row-id="1" data-no="33-1-28" data-st="N"></span>
      <span class="seat empty" data-column-id="" data-row-id="1" data-no="" data-st="E"></span>
    </div>
    <div class="row">
      <span class="seat sold" data-column-id="33" data-row-id="10" data-no="33-10-33" data-st="LK"></span>
      <span class="seat empty" data-column-id="" data-row-id="10" data-no="" data-st="E"></span>
      <span class="seat selectable" data-column-id="31" data-row-id="10" data-no="33-10-31" data-st="N"></span>
    </div>
  </div>`;
  const map = parseSeatPage(html);
  assert.equal(map.cols, 37);
  assert.deepEqual(map.seats.map((s) => [s.seatNo, s.orderIndex]), [
    ["33-1-29", 5], ["33-1-28", 6],   // 排1: 首座 29 在格位 5(前面 4 个过道占位)
    ["33-10-33", 1],                   // 排10: 孤立座 33 在格位 1
    ["33-10-31", 3]                    // 排10: 31 座在第 3 格(孤立座 + 1 占位之后)
  ]);
});

test("extracts the official seats block for side-by-side rendering and strips scripts", () => {
  // 真实用途: 前端在沙箱 iframe 里配合官方 CSS 副本渲染 1:1 主站座位图。
  // 提取整块 seats-block, 剥离 script/注释/埋点属性(data-act/data-bid), 压缩标签间空白。
  const html = `<html><head><script>alert(1)</script></head><body>
    <div class="seats-block" data-section-id="1" data-section-name="普通区" data-seq-no="100" data-cols="37">
      <span class="seat selectable" data-row-id="1" data-column-id="1" data-no="1-1-1" data-st="N" data-act="seat-click" data-bid="b_x"></span>
      <!-- tracking -->
      <script>track()</script>
      <span class="seat sold" data-row-id="1" data-column-id="2" data-no="1-1-2" data-st="N"></span>
    </div>
  </body></html>`;
  const out = extractOfficialSeatHtml(html);
  assert.ok(out.startsWith('<div class="seats-block"'), "从 seats-block 开始标签起提取");
  assert.ok(out.includes('data-no="1-1-1"') && out.includes('data-no="1-1-2"'), "座位 DOM 完整保留");
  assert.ok(!out.includes("<script"), "脚本剥离");
  assert.ok(!out.includes("<!--"), "注释剥离");
  assert.ok(!out.includes("data-act") && !out.includes("data-bid"), "埋点属性剥离");
  assert.ok(!/>\\s+</.test(out), "标签间空白已压缩");
  assert.equal(extractOfficialSeatHtml("<html><body>无座位</body></html>"), "");
  assert.equal(extractOfficialSeatHtml('<div class="seats-block"><div>未闭合'), "", "提取失败返回空串不抛错");
});

test("parses seats only from the matched seats block", () => {
  const map = parseSeatPage(`${seatHtml}
    <aside><span class="seat selectable" data-row-id="9" data-column-id="9" data-no="1-9-9" data-st="N"></span></aside>`);
  assert.deepEqual(map.seats.map((seat) => seat.seatNo), ["1-6-18", "1-6-19"]);
});

test("accepts alphanumeric section ids and multi-line seat attributes from real pages", () => {
  // 真实语料(超低价区/特价区/特惠区共 9 页): section-id 为字母数字混合 "A001", 且座位属性多行排布
  const html = `<div class="seats-block"
    data-section-id="A001"
    data-section-name="超低价区"
    data-seq-no="202609130135454">
    <span class="seat selectable"
              data-column-id="20"
              data-row-id="1"
              data-no="0000000000000001-1-20"
              data-st="N"
              data-act="seat-click">
    <span class="seat sold"
              data-column-id="19"
              data-row-id="1"
              data-no="0000000000000001-1-19"
              data-st="LK">
  </div>`;
  const map = parseSeatPage(html);
  assert.equal(map.sectionId, "A001");
  assert.equal(map.sectionName, "超低价区");
  assert.equal(map.seqNo, "202609130135454");
  assert.deepEqual(map.seats.map((seat) => seat.seatNo), ["0000000000000001-1-20", "0000000000000001-1-19"]);
});

test("rejects malformed section ids and empty section names", () => {
  assert.throws(() => parseSeatPage(`<div class="seats-block" data-section-id="" data-section-name="x" data-seq-no="1"><span class="seat selectable" data-row-id="1" data-column-id="1" data-no="1-1-1"></span></div>`), /猫眼座位图格式无效/);
  assert.throws(() => parseSeatPage(`<div class="seats-block" data-section-id="a b" data-section-name="x" data-seq-no="1"><span class="seat selectable" data-row-id="1" data-column-id="1" data-no="1-1-1"></span></div>`), /猫眼座位图格式无效/);
  assert.throws(() => parseSeatPage(`<div class="seats-block" data-section-id="1" data-section-name="" data-seq-no="1"><span class="seat selectable" data-row-id="1" data-column-id="1" data-no="1-1-1"></span></div>`), /猫眼座位图格式无效/);
});

test("renders the hall row/seat out of the Maoyan seat identifier", () => {
  // 真实订单锚定(万达影城 2号杜比巨幕厅): seatNo=1-1-10 / rowId=9 的订单票面为「9排1座」。
  // 即: 票面排号 = rowId(1..N 连续), 票面座号 = seatNo 第二段(过道处跳号);
  // data-no 第三段是影厅内部物理排号(1,2,3,5..12 跳过"4排"), 与票面在第 3 排后错位 +1, 不可用。
  assert.equal(seatDisplayLabel({ seatNo: "1-1-10", rowId: "9" }), "9排1座");
  assert.equal(seatDisplayLabel({ seatNo: "1-12-1", rowId: "1" }), "1排12座");
  // 去掉前导零, 保留排/座语义
  assert.equal(seatDisplayLabel({ seatNo: "1-05-07", rowId: "07" }), "7排5座");
  // 只有 seatNo 字符串无法换算票面排号, 原样返回(不猜测)
  assert.equal(seatDisplayLabel("1-12-1"), "1-12-1");
  assert.equal(seatDisplayLabel("1-12"), "1-12");
  // rowId 缺失/非法时回退为原始标识
  assert.equal(seatDisplayLabel({ seatNo: "1-28-3" }), "1-28-3");
  assert.equal(seatDisplayLabel({ seatNo: "1-30-12", rowId: "" }), "1-30-12");
  assert.equal(seatDisplayLabel(""), "");
  assert.equal(seatDisplayLabel(null), "");
});

test("parsed identifiers keep the raw seatNo while row/column stay parse ordinals", () => {
  // 回归护栏: 真实场次数据(2号杜比巨幕厅)。rowId 是票面排号, data-no 第三段是内部物理排号。
  // 注意第 4 行起两种口径错位: rowId=9 的座位票面为 9 排, 而 data-no 第三段是 10。
  const map = parseSeatPage(`
    <div class="seats-block" data-section-id="1" data-section-name="2号杜比巨幕厅" data-seq-no="202609120148439">
      <span class="seat selectable" data-row-id="1" data-column-id="10" data-no="1-12-1" data-st="N"></span>
      <span class="seat selectable" data-row-id="9" data-column-id="1" data-no="1-1-10" data-st="N"></span>
    </div>`);
  assert.deepEqual(map.seats.map((seat) => [seat.seatNo, seat.rowId, seat.columnId]), [
    ["1-12-1", "1", "10"],
    ["1-1-10", "9", "1"]
  ]);
  // 同一份数据: 票面是 1排12座、9排1座(data-no 第三段的 1、10 均不是票面排号口径)
  assert.deepEqual(map.seats.map(seatDisplayLabel), ["1排12座", "9排1座"]);
});

test("detects the swapped seatNo segment order of laser IMAX halls", () => {
  // 真实座位页锚定(寰映影城大融城 1号激光IMAX厅 seqNo=202609170005201):
  // data-no=区-排号-座号, 11 排(rowId 1..11)、座号取值 1..35, 与杜比厅的「区-座号-物理排」相反。
  // 此前把第二段固定当座号(列), 同排全部座位挤进同一列, 座位图渲染成一根竖条。
  const imaxSeats = [
    { seatNo: "33-1-29", rowId: "1", columnId: "29" },
    { seatNo: "33-1-30", rowId: "1", columnId: "30" },
    { seatNo: "33-2-31", rowId: "2", columnId: "31" },
    { seatNo: "33-11-1", rowId: "11", columnId: "1" }
  ];
  assert.equal(seatSegmentOf(imaxSeats), 3);
  const seg = seatSegmentOf(imaxSeats);
  assert.equal(seatDisplayLabel(imaxSeats[0], seg), "1排29座");
  assert.equal(seatDisplayLabel(imaxSeats[3], seg), "11排1座");
  // 杜比厅口径不受影响: 第二段唯一值多于第三段 → 维持第二段=座号
  const dolbySeats = [
    { seatNo: "1-12-1", rowId: "1", columnId: "10" },
    { seatNo: "1-1-10", rowId: "9", columnId: "1" }
  ];
  assert.equal(seatSegmentOf(dolbySeats), 2);
  // 保守护栏: 座位过少无法区分口径时回退旧口径(第二段=座号)
  assert.equal(seatSegmentOf([{ seatNo: "1-1-1", rowId: "1" }]), 2);
  assert.equal(seatSegmentOf([]), 2);
  assert.equal(seatSegmentOf(null), 2);
});

test("resolves 区-排-座 labels without a seat map via the rowId/columnId signal", () => {
  // 回归(真实缺陷): 已保存规则重开/单座规则推送时无座位图可普查, 缺省 seg=2(万达「区-座-排」假设)
  // 把寰映型「区-排-座」的排号段误当座号 —— KV 座位 32-9-15/rowId 9/columnId 15 显示成 9排9座。
  // 强信号: 三段全数字且 seg2===rowId、seg3===columnId → 座号取 seg3, 与普查结论一致。
  const seat = { seatNo: "32-9-15", rowId: "9", columnId: "15", type: "LK" };
  assert.equal(seatDisplayLabel(seat, 2), "9排15座");
  assert.equal(seatDisplayLabel(seat, 3), "9排15座");
  // 万达型不满足强信号(seg2=座号≠rowId): 维持判别段口径
  assert.equal(seatDisplayLabel({ seatNo: "1-1-10", rowId: "9", columnId: "1" }, 2), "9排1座");
  assert.equal(seatDisplayLabel({ seatNo: "1-12-1", rowId: "1", columnId: "10" }, 2), "1排12座");
  // columnId 缺失(旧数据形状)时不触发强信号, 行为不变
  assert.equal(seatDisplayLabel({ seatNo: "1-1-10", rowId: "9" }, 2), "9排1座");
});

test("keeps #-delimited and numeric seatNos and still drops empty placeholders", () => {
  // 55 页普查: 金逸等影院 data-no=影厅长编码#排#座(两位前导零), 部分影院为纯数字 seatId。
  // data-no 是官方原样透传的不透明主键, 解析只保留原文; 空位/走道(无 data-no 或空值)继续过滤。
  const html = `
    <div class="seats-block" data-section-id="9" data-section-name="4号厅" data-seq-no="2026091301">
      <span class="seat selectable" data-row-id="1" data-column-id="1" data-no="4401028106#01#01" data-st="N"></span>
      <span class="seat sold" data-row-id="1" data-column-id="2" data-no="4401028106#01#02" data-st="N"></span>
      <span class="seat selectable" data-row-id="2" data-column-id="3" data-no="7376" data-st="N"></span>
      <span class="seat walkway" data-row-id="2" data-column-id="4" data-no="" data-st="N"></span>
      <span class="seat selectable" data-row-id="2" data-column-id="5" data-st="N"></span>
    </div>`;
  const map = parseSeatPage(html);
  assert.deepEqual(map.seats.map((seat) => seat.seatNo), ["4401028106#01#01", "4401028106#01#02", "7376"]);
  assert.deepEqual(map.seats.map((seat) => [seat.rowId, seat.columnId, seat.available]), [
    ["1", "1", true], ["1", "2", false], ["2", "3", true]
  ]);
});

test("discriminates the seat segment within rows for hash, multi-zone and dolby layouts", () => {
  // 金逸 # 样本: 同排 seg2(排号,前导零)恒定、seg3(座号)逐座变化 → 行内判别为 3
  const hashSeats = [
    { seatNo: "4401028106#01#01", rowId: "1", columnId: "1" },
    { seatNo: "4401028106#01#02", rowId: "1", columnId: "2" },
    { seatNo: "4401028106#02#01", rowId: "2", columnId: "1" }
  ];
  assert.equal(seatSegmentOf(hashSeats), 3);
  assert.equal(seatDisplayLabel(hashSeats[0], 3), "1排1座");
  // 多区厅(寰映星河形状): seg1 行内混区, 但 seg2 排号行内恒定 → 不影响判别
  const multiZone = [
    { seatNo: "1-3-11", rowId: "3", columnId: "1" },
    { seatNo: "32-3-12", rowId: "3", columnId: "2" },
    { seatNo: "33-3-13", rowId: "3", columnId: "3" }
  ];
  assert.equal(seatSegmentOf(multiZone), 3);
  // 万达天和型(区-座-排): 同排 seg2(座号)逐座变化、seg3(物理排)恒定 → 2
  const dolbyRow = [
    { seatNo: "1-1-11", rowId: "11", columnId: "1" },
    { seatNo: "1-2-11", rowId: "11", columnId: "2" },
    { seatNo: "1-3-11", rowId: "11", columnId: "3" }
  ];
  assert.equal(seatSegmentOf(dolbyRow), 2);
  assert.equal(seatDisplayLabel(dolbyRow[1], 2), "11排2座");
});

test("falls back to parse ordinals for numeric seat ids the way the official bubble does", () => {
  // 纯数字 seatId(约 15% 影院)无法从 data-no 推出排/座: 与官方「已选座」气泡同口径,
  // 显示 rowId排columnId座(官方前端解码实证气泡就是解析序号)。
  const seat = { seatNo: "7376", rowId: "9", columnId: "12" };
  assert.equal(seatDisplayLabel(seat, 2), "9排12座");
  assert.equal(seatDisplayLabel(seat, 3), "9排12座");
  // columnId 缺失时原样返回
  assert.equal(seatDisplayLabel({ seatNo: "7376", rowId: "9" }), "7376");
  assert.equal(
    seatDisplayLabel({ seatNo: "6166", rowId: "A", columnId: "26" }),
    "A排26座"
  );
});

test("matches only the exact target date and HH:mm", () => {
  const data = { showData: { movies: [{ id: 7, shows: [{ showDate: "2026-09-12", plist: [
    { seqNo: "1", tm: "19:59" }, { seqNo: "2", tm: "20:00" }, { seqNo: "3", tm: "20:05" }
  ] }] }] } };
  assert.deepEqual(findExactShows(data, {
    movieId: "7", targetDate: "2026-09-12", templateTime: "20:00"
  }).map((show) => show.seqNo), ["2"]);
});

test("matches same-hall shows within an inclusive thirty-minute window", () => {
  const data = { showData: { movies: [{ id: 7, shows: [{ showDate: "2026-09-12", plist: [
    { seqNo: "outside-before", tm: "18:09", th: "1号激光IMAX厅" },
    { seqNo: "edge-before", tm: "18:10", th: "1号激光IMAX厅" },
    { seqNo: "near", tm: "18:50", th: "1号激光IMAX厅" },
    { seqNo: "edge-after", tm: "19:10", th: "1号激光IMAX厅" },
    { seqNo: "outside-after", tm: "19:11", th: "1号激光IMAX厅" },
    { seqNo: "other-hall", tm: "18:50", th: "2号激光IMAX厅" },
    { seqNo: "sold", tm: "18:45", th: "1号激光IMAX厅", ticketStatus: 1 }
  ] }] }] } };

  const matches = findCompatibleShows(data, {
    movieId: "7",
    targetDate: "2026-09-12",
    templateTime: "18:40",
    templateHall: "1号激光IMAX厅"
  });

  assert.deepEqual(matches.map((show) => [show.seqNo, show.timeDeltaMinutes, show.matchMode]), [
    ["near", 10, "fuzzy"],
    ["edge-after", 30, "fuzzy"],
    ["edge-before", -30, "fuzzy"]
  ]);
});

test("does not match fuzzy shows without a valid exact hall or time", () => {
  const data = { showData: { movies: [{ id: 7, shows: [{ showDate: "2026-09-12", plist: [
    { seqNo: "missing-hall", tm: "18:40" },
    { seqNo: "invalid-time", tm: "18:xx", th: "1号激光IMAX厅" }
  ] }, { showDate: "2026-09-13", plist: [{ seqNo: "wrong-date", tm: "18:40", th: "1号激光IMAX厅" }] }] }] } };

  assert.deepEqual(findCompatibleShows(data, {
    movieId: "7",
    targetDate: "2026-09-12",
    templateTime: "18:40",
    templateHall: "1号激光IMAX厅"
  }).map((show) => show.seqNo), []);
});

test("refuses redirects and requests outside www.maoyan.com", async () => {
  await assert.rejects(
    () => requestMaoyan(session, "https://example.com/xseats/1"),
    /请求目标不受信任/
  );
  await withMockFetch(async () => new Response(null, {
    status: 302,
    headers: { location: "https://example.com/" }
  }), async () => {
    await assert.rejects(
      () => requestMaoyan(session, "https://www.maoyan.com/xseats/1"),
      /猫眼请求失败：HTTP 302/
    );
  });
});

test("fetches a seat map through the fixed authenticated endpoint", async () => {
  await withMockFetch(async (input, init) => {
    const url = new URL(input);
    assert.equal(url.href, "https://www.maoyan.com/xseats/2026091201?movieId=7&cinemaId=25428");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Cookie, "uid=test-user; token=test-cookie");
    return new Response(seatHtml, { status: 200 });
  }, async () => {
    const map = await fetchSeatMap(session, { cinemaId: "25428", movieId: "7", seqNo: "2026091201" });
    assert.equal(map.movieId, "7");
    assert.equal(map.cinemaId, "25428");
    assert.equal(map.seats.length, 2);
    assert.equal(map.seats[0].available, true);
  });
});

test("creates an unpaid order using session-captured query values only", async () => {
  const seatMap = { ...parseSeatPage(seatHtml), movieId: "7", cinemaId: "25428" };
  await withMockFetch(async (input, init) => {
    const url = new URL(input);
    // 下单走 m 站(www 站 createOrder 对数据中心出口 IP 返回 403)
    assert.equal(url.origin, "https://m.maoyan.com");
    assert.equal(url.pathname, "/ajax/createOrder");
    // 会话捕获的值优先(签名版本须与登录会话匹配)
    assert.deepEqual([...url.searchParams.entries()].sort(), [
      ["csecplatform", "4"],
      ["csecversion", "4.3.0"],
      ["yodaReady", "h5"]
    ]);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Cookie, "uid=test-user; token=test-cookie");
    assert.equal(Object.hasOwn(init.headers, "mtgsig"), false);
    assert.equal(init.headers.Origin, "https://m.maoyan.com");
    assert.equal(init.headers.Referer, "https://m.maoyan.com/");
    assert.equal(init.headers["User-Agent"], "Test Agent/1.0");
    assert.equal(init.headers.Accept, "application/json, text/plain, */*");
    assert.equal(init.headers["Accept-Language"], "zh-CN,zh;q=0.9");
    assert.equal(init.headers["X-Requested-With"], "XMLHttpRequest");
    const payload = new URLSearchParams(init.body);
    assert.deepEqual([...payload.entries()], [
      ["sectionId", "88"],
      ["sectionName", "1号厅 & 特效"],
      ["seqNo", "2026091201"],
      ["seats", '{"count":1,"list":[{"rowId":"6","columnId":"18","seatNo":"1-6-18","type":"N"}]}']
    ]);
    return jsonResponse({ data: { data: { id: 12345, payLeftSecond: 600 } } });
  }, async () => {
    assert.deepEqual(
      await createUnpaidOrder(session, seatMap, ["1-6-18"]),
      { orderId: "12345", payLeftSecond: 600 }
    );
  });
});

test("recognizes the mobile order success envelope", async () => {
  await withMockFetch(async () => jsonResponse({
    success: true,
    status: 0,
    data: { id: 12345, order: { movieId: 7 }, payLeftSecond: 598 }
  }), async () => {
    assert.deepEqual(
      await createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
      { orderId: "12345", payLeftSecond: 598 }
    );
  });
});

test("preserves nested order success when the envelope includes success flags", async () => {
  await withMockFetch(async () => jsonResponse({
    success: true, status: 0, data: { data: { id: 12345, payLeftSecond: 600 } }
  }), async () => {
    assert.deepEqual(
      await createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
      { orderId: "12345", payLeftSecond: 600 }
    );
  });
});

test("does not accept order identifiers from explicitly failed envelopes", async () => {
  for (const flags of [{ success: false }, { status: 1 }, { code: 401 }]) {
    for (const data of [{ id: 12345 }, { data: { id: 12345 } }]) {
      await withMockFetch(async () => jsonResponse({ ...flags, data }), async () => {
        await assert.rejects(
          () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
          (error) => error instanceof OrderAttemptError && error.uncertain === false
        );
      });
    }
  }
});

test("does not treat an unconfirmed mobile identifier as a successful order", async () => {
  for (const payload of [
    { data: { id: 12345 } },
    { success: true, status: 0, data: { id: "" } },
    { success: true, status: 0, data: { id: 0 } }
  ]) {
    await withMockFetch(async () => jsonResponse(payload), async () => {
      await assert.rejects(
        () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
        (error) => error instanceof OrderAttemptError
      );
    });
  }
});

test("classifies an explicit provider rejection as a certain order failure", async () => {
  await withMockFetch(async () => jsonResponse({ data: { msg: "seat unavailable" } }), async () => {
    await assert.rejects(
      () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
      (error) => error instanceof OrderAttemptError && error.uncertain === false && !error.message.includes("test-signature")
    );
  });
});

test("classifies a 409 JSON provider rejection as a certain order failure", async () => {
  await withMockFetch(async () => jsonResponse({ data: { msg: "provider-private-detail" } }, 409), async () => {
    await assert.rejects(
      () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
      (error) => {
        assert.equal(error instanceof OrderAttemptError, true);
        assert.equal(error.uncertain, false);
        assert.equal(error.message.includes("provider-private-detail"), false);
        return true;
      }
    );
  });
});

test("does not write provider credentials or internal URLs to order logs", async () => {
  const sessionWithPrivateQuery = {
    ...session,
    createOrderQuery: {
      ...session.createOrderQuery,
      signature: "provider-query-secret"
    }
  };
  const providerError = {
    error: {
      name: "NetError",
      message: "Bad Request",
      url: "http://internal.example/order/createOrder.json",
      header: {
        Key: "provider-key-secret",
        Token: "provider-token-secret"
      }
    }
  };
  const { text: logs, entries } = await captureConsole(async () => {
    await withMockFetch(async () => jsonResponse(providerError), async () => {
      await assert.rejects(
        () => createUnpaidOrder(sessionWithPrivateQuery, parseSeatPage(seatHtml), ["1-6-18"]),
        (error) => error instanceof OrderAttemptError &&
          error.uncertain === false &&
          error.message === "猫眼拒绝当前下单请求，请稍后重试或重新上传会话"
      );
    });
  });

  assert.equal(entries.every((args) => args.length === 1 && typeof args[0] === "object"), true);
  assert.match(logs, /"scope":"maoyan-lock"/);
  assert.match(logs, /"event":"order_attempt"/);
  assert.match(logs, /"httpStatus":200/);
  assert.match(logs, /"errorName":"NetError"/);
  assert.match(logs, /"errorMessage":"Bad Request"/);
  assert.doesNotMatch(logs, /provider-key-secret|provider-token-secret|provider-query-secret|internal\.example/);
});

test("logs sanitized diagnostics for a non-JSON order rejection", async () => {
  const privateBody = `<!doctype html><title>Access Denied</title>
    <p>Forbidden cf-chl-captcha private-provider-detail</p>`;
  const { text: logs } = await captureConsole(async () => {
    await withMockFetch(async () => new Response(privateBody, {
      status: 403,
      headers: {
        "content-type": "text/html; charset=UTF-8",
        server: "cloudflare",
        "cf-mitigated": "challenge"
      }
    }), async () => {
      await assert.rejects(
        () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
        /锁座失败/
      );
    });
  });

  assert.match(logs, /"httpStatus":403/);
  assert.match(logs, /"contentType":"text\/html; charset=UTF-8"/);
  assert.match(logs, /"server":"cloudflare"/);
  assert.match(logs, /"mitigation":"challenge"/);
  assert.match(logs, /"bodyLength":\d+/);
  assert.match(logs, /"responseHint":"页面 Access Denied; 标记 challenge,forbidden"/);
  assert.match(logs, /private-provider-detail|cf-chl-captcha/);
});

test("unrecognized order responses do not expose provider data through error detail", async () => {
  const payload = { token: "private-provider-token", url: "http://internal.example/order", data: {} };
  await withMockFetch(async () => jsonResponse(payload), async () => {
    await assert.rejects(
      () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
      (error) => {
        assert.equal(error instanceof OrderAttemptError, true);
        assert.doesNotMatch(`${error.message} ${error.detail}`, /private-provider-token|internal\.example/);
        assert.match(error.detail, /HTTP 200/);
        return true;
      }
    );
  });
});

test("HTML order errors do not expose private titles through error detail", async () => {
  await withMockFetch(async () => new Response("<title>private-provider-token</title>", { status: 403 }), async () => {
    await assert.rejects(
      () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
      (error) => {
        assert.doesNotMatch(`${error.message} ${error.detail}`, /private-provider-token/);
        assert.match(error.detail, /HTTP 403/);
        return true;
      }
    );
  });
});

test("order logs correlate a failed response without exposing credentials", async () => {
  const { entries, text: logs } = await captureConsole(async () => {
    await withMockFetch(async () => new Response('<Error><Code>InvalidRequest</Code></Error>', {
      status: 400, headers: { 'content-type': 'text/xml' }
    }), async () => {
      await assert.rejects(() => createUnpaidOrder(session, parseSeatPage(seatHtml), ['1-6-18']));
    });
  });
  const events = entries.map(args => args[0]).filter(event => event.event === 'order_attempt');
  assert.ok(events.length >= 2);
  assert.match(events[0].attemptId, /^[a-f0-9-]{36}$/);
  assert.ok(events.every(event => event.attemptId === events[0].attemptId));
  const failed = events.find(event => event.state === 'failed');
  assert.equal(failed.httpStatus, 400);
  assert.equal(failed.responseType, 'xml');
  assert.equal(failed.seqNo, '2026091201');
  assert.equal(failed.endpoint, 'https://m.maoyan.com/ajax/createOrder');
  assert.ok(failed.durationMs >= 0);
  assert.match(failed.responseBody, /InvalidRequest/);
  assert.doesNotMatch(logs, /test-signature|test-cookie|test-csrf/);
});

test("failed JSON response logs are bounded and redact credential-shaped fields", async () => {
  const payload = {
    error: "Bad Request",
    token: "private-token",
    mtgsig: "private-signature",
    data: { message: "seat unavailable", cookie: "private-cookie" }
  };
  const { entries } = await captureConsole(async () => {
    await withMockFetch(async () => jsonResponse(payload, 400), async () => {
      await assert.rejects(() => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]));
    });
  });
  const failed = entries.map(args => args[0]).find(event => event.event === "order_attempt" && event.state === "failed");
  assert.ok(failed);
  assert.match(failed.responseBody, /redacted/);
  assert.doesNotMatch(failed.responseBody, /private-token|private-signature|private-cookie/);
  assert.ok(failed.responseBody.length <= 2000);
});

test("failure detail captures diagnostic headers and redacts structured and echoed credentials", async () => {
  const payload = { error: "rejected", accessToken: "unknown-secret", nested: { "uid.sig": "unknown-signature" }, message: "test-cookie test-csrf test-signature", note: "Bearer unknown-bearer" };
  await withMockFetch(async () => new Response(JSON.stringify(payload), { status: 403, headers: {
    "content-type": "application/json", "cf-ray": "trace-123", "set-cookie": "new-secret", "x-custom": "private"
  } }), async () => {
    await assert.rejects(() => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]), error => {
      const detail = JSON.parse(error.failureDetail);
      assert.equal(detail.httpStatus, 403);
      assert.deepEqual(detail.headers, { "content-type": "application/json", "cf-ray": "trace-123" });
      assert.equal(detail.bodyTruncated, false);
      assert.match(detail.responseBody, /rejected/);
      assert.doesNotMatch(error.failureDetail, /unknown-secret|unknown-signature|unknown-bearer|test-cookie|test-csrf|test-signature|new-secret/);
      return true;
    });
  });
});

test("failure detail preserves HTML diagnostics, redacts credentials and caps UTF-8 body size", async () => {
  const html = '<title>Access Denied</title>cf-chl-captcha Cookie: arbitrary=cookie-value; another=second-value\n<token>xml-secret</token> signature="quoted secret" ' + "座".repeat(7000);
  await withMockFetch(async () => new Response(html, { status: 403 }), async () => {
    await assert.rejects(() => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]), error => {
      const detail = JSON.parse(error.failureDetail);
      assert.equal(detail.bodyTruncated, true);
      assert.ok(new TextEncoder().encode(detail.responseBody).length <= 16384);
      assert.ok(detail.responseBody.length > 4000);
      assert.match(detail.responseBody, /Access Denied.*cf-chl-captcha/);
      assert.doesNotMatch(detail.responseBody, /cookie-value|second-value|xml-secret|quoted secret/);
      assert.doesNotMatch(error.detail, /Access Denied|cf-chl/);
      return true;
    });
  });
});

test("classifies ambiguous post-order failures as uncertain", async () => {
  const failures = [
    async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    },
    async () => { throw new Error("socket closed"); },
    async () => new Response("not json", { status: 200 }),
    async () => jsonResponse({ data: { data: {} } })
  ];
  for (const mock of failures) {
    await withMockFetch(mock, async () => {
      await assert.rejects(
        () => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]),
        (error) => error instanceof OrderAttemptError && error.uncertain === true && !error.message.includes("test-signature")
      );
    });
  }
});

test("redirect order failures retain their response diagnostics without following redirects", async () => {
  await withMockFetch(async () => new Response("login required", { status: 302, headers: { location: "https://private.example" } }), async () => {
    await assert.rejects(() => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]), error => {
      const detail = JSON.parse(error.failureDetail);
      assert.equal(detail.httpStatus, 302);
      assert.match(detail.responseBody, /login required/);
      assert.doesNotMatch(error.failureDetail, /private.example/);
      return true;
    });
  });
});

test("failure detail redacts HTML form credential values", async () => {
  await withMockFetch(async () => new Response('<input value="hidden-secret" name="csrf_token"><input name="signature" value="second-secret">', { status: 403 }), async () => {
    await assert.rejects(() => createUnpaidOrder(session, parseSeatPage(seatHtml), ["1-6-18"]), error => {
      assert.equal(typeof error.failureDetail, "string");
      assert.doesNotMatch(error.failureDetail, /hidden-secret|second-secret/);
      return true;
    });
  });
});
