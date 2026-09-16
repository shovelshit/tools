export function cinemaFixture({ cinemaId = "1", movieIds = ["7"], seqNos = ["s1"] } = {}) {
  return {
    cinemaId: String(cinemaId),
    showData: {
      cinemaName: `影院 ${cinemaId}`,
      movies: movieIds.map((movieId, movieIndex) => ({
        id: String(movieId),
        nm: `影片 ${movieId}`,
        shows: [{
          showDate: "2026-09-19",
          plist: seqNos.map((seqNo, showIndex) => ({
            seqNo: String(seqNo),
            tm: `${18 + movieIndex}:${String(40 + showIndex).padStart(2, "0")}`,
            th: "1号厅",
            lang: "国语",
            tp: "2D"
          }))
        }]
      }))
    }
  };
}

export function createStorageFixture() {
  const data = new Map();
  let alarm = null;
  return {
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list() { return new Map(data); },
    async setAlarm(value) { alarm = value; },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = null; },
    async transaction(callback) { return await callback(this); }
  };
}
