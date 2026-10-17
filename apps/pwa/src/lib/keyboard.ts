/** 入力欄の上下に残す余白。キーボードのすぐ上に張り付かないようにする */
const MARGIN = 24;

/** フォーカスしている入力欄が、キーボードを除いた見えている範囲から余白付きではみ出していれば、見える位置までスクロールする */
function reveal() {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  const vv = window.visualViewport;
  const top = vv?.offsetTop ?? 0;
  const bottom = top + (vv?.height ?? innerHeight);
  const r = el.getBoundingClientRect();
  if (r.top < top + MARGIN || r.bottom > bottom - MARGIN) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * スマホのキーボードで入力欄が隠れないようにする。
 * 見えている範囲（visual viewport）を --vv-top / --vv-height に入れ、下から出るシートや撮影画面をその中に収める。
 * キーボードが開いたときやフォーカスが移ったときに、入力欄を余白付きで見える位置へスクロールする。
 */
export function followKeyboard() {
  const vv = window.visualViewport;
  if (vv) {
    const style = document.documentElement.style;
    const update = () => {
      style.setProperty("--vv-top", `${vv.offsetTop}px`);
      style.setProperty("--vv-height", `${vv.height}px`);
    };
    update();
    vv.addEventListener("resize", () => (update(), reveal()));
    vv.addEventListener("scroll", update);
  }
  // キーボードが出きる前に測るとずれるので、少し待ってから合わせる
  document.addEventListener("focusin", () => setTimeout(reveal, 300));
}
