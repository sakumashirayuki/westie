import type { ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/** 距底部多远开始显示「回到最新」按钮（px）；更近视为仍在看最新内容。 */
const showThreshold = 200;

/**
 * 对话区滚动容器 + 悬浮「回到最新」按钮。
 *
 * 滚动位置由本组件持有：点击按钮滚到底后立即隐藏按钮。自动跟底仍由浏览器
 * 既有的滚动行为决定，本组件只在用户离开底部时提供回到最新的入口。
 */
export function ScrollToBottomArea({ children }: { children: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [distanceToBottom, setDistanceToBottom] = useState(0);
  // 内容追加时也可能拉大与底部的距离，同样需要重新判定。
  const contentRef = useRef<HTMLDivElement | null>(null);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    setDistanceToBottom(
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    );
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(content);
    return () => observer.disconnect();
  }, [measure]);

  function scrollToBottom(): void {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const reducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    // 平滑滚动期间内容仍在变长，先按「已到底」收起，后续 scroll 事件会校正。
    setDistanceToBottom(0);
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
        onScroll={measure}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {distanceToBottom > showThreshold && (
        <button
          type="button"
          aria-label="回到最新"
          className="absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-[#d9dbd3] bg-[#fcfcf9] text-[#276c52] shadow-[0_6px_18px_rgba(20,32,27,0.12)] transition hover:bg-[#eef4ef]"
          onClick={scrollToBottom}
        >
          <ArrowDown className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
