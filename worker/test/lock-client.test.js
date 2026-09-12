import test from "node:test";
import assert from "node:assert/strict";
import { captureConsole } from "./helpers.js";
import {
  createUnpaidOrder,
  fetchSeatMap,
  findExactShows,
  OrderAttemptError,
  parseSeatPage,
  requestMaoyan,
  seatDisplayLabel,
  seatLabelFromNo
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

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
  assert.deepEqual(map.seats, [
    { rowId: "6", columnId: "18", seatNo: "1-6-18", type: "N", available: true },
    { rowId: "6", columnId: "19", seatNo: "1-6-19", type: "N", available: false }
  ]);
});

test("parses seats only from the matched seats block", () => {
  const map = parseSeatPage(`${seatHtml}
    <aside><span class="seat selectable" data-row-id="9" data-column-id="9" data-no="1-9-9" data-st="N"></span></aside>`);
  assert.deepEqual(map.seats.map((seat) => seat.seatNo), ["1-6-18", "1-6-19"]);
});

test("renders the hall row/seat out of the Maoyan seat identifier", () => {
  // 实测样本: 万达影城(天和广场) 2号杜比巨幕厅,
  // 1-12-1 表示 1区/12号座/第1排 => 票面「1排12座」;
  // 该影厅没有 4 排(排号跳号)、第10/11排在 3、4 与 27、28 号处留过道。
  assert.equal(seatDisplayLabel("1-12-1"), "1排12座");
  assert.equal(seatDisplayLabel({ seatNo: "1-28-3" }), "3排28座");
  assert.equal(seatDisplayLabel({ seatNo: "1-30-12" }), "12排30座");
  // 去掉前导零, 但保留排/座语义
  assert.equal(seatLabelFromNo("1-05-07"), "7排5座");
  // 非标准标识原样返回, 不吞掉原始值
  assert.equal(seatDisplayLabel("1-12"), "1-12");
  assert.equal(seatDisplayLabel("1-12-x"), "1-12-x");
  assert.equal(seatDisplayLabel(""), "");
  assert.equal(seatDisplayLabel(null), "");
});

test("parsed identifiers keep the raw seatNo while row/column stay parse ordinals", () => {
  // 回归护栏: rowId/columnId 是影厅内部的连续序号, 与票面排座号不同口径, 不可混用
  const map = parseSeatPage(`
    <div class="seats-block" data-section-id="1" data-section-name="2号杜比巨幕厅" data-seq-no="202609120148439">
      <span class="seat selectable" data-row-id="1" data-column-id="10" data-no="1-12-1" data-st="N"></span>
      <span class="seat selectable" data-row-id="4" data-column-id="1" data-no="1-5-5" data-st="N"></span>
    </div>`);
  assert.deepEqual(map.seats.map((seat) => [seat.seatNo, seat.rowId, seat.columnId]), [
    ["1-12-1", "1", "10"],
    ["1-5-5", "4", "1"]
  ]);
  // 同一份数据: 内部序号是 1排10座、4排1座, 票面是 1排12座、5排5座
  assert.deepEqual(map.seats.map(seatDisplayLabel), ["1排12座", "5排5座"]);
});

test("matches only the exact target date and HH:mm", () => {
  const data = { showData: { movies: [{ id: 7, shows: [{ showDate: "2026-09-12", plist: [
    { seqNo: "1", tm: "19:59" }, { seqNo: "2", tm: "20:00" }, { seqNo: "3", tm: "20:05" }
  ] }] }] } };
  assert.deepEqual(findExactShows(data, {
    movieId: "7", targetDate: "2026-09-12", templateTime: "20:00"
  }).map((show) => show.seqNo), ["2"]);
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
    assert.equal(url.origin, "https://www.maoyan.com");
    assert.equal(url.pathname, "/ajax/createOrder");
    // 会话捕获的值优先(签名版本须与登录会话匹配)
    assert.deepEqual([...url.searchParams.entries()].sort(), [
      ["csecplatform", "4"],
      ["csecversion", "4.3.0"],
      ["yodaReady", "h5"]
    ]);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Cookie, "uid=test-user; token=test-cookie");
    assert.equal(init.headers.mtgsig, "test-signature");
    assert.equal(init.headers.Origin, "https://www.maoyan.com");
    assert.equal(init.headers.Referer, "https://www.maoyan.com/xseats/2026091201?movieId=7&cinemaId=25428");
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
