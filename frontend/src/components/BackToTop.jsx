import React, { useEffect, useState } from "react";

// A floating "TO TOP" button (HDFC-app style): appears once the page is scrolled
// down, click to smooth-scroll back to the top. The app's content scrolls on the
// window, so that is what we watch.
export default function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!show) return null;

  return (
    <button
      type="button"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed bottom-5 right-5 z-40 flex flex-col items-center gap-0.5 rounded-xl
        bg-navy-800/95 px-4 py-2.5 text-white shadow-xl ring-1 ring-black/10 backdrop-blur
        transition hover:bg-navy-700 active:scale-95"
    >
      <span className="text-lg leading-none">↑</span>
      <span className="text-[11px] font-semibold tracking-wide">TO TOP</span>
    </button>
  );
}
