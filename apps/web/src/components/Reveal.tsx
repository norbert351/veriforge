"use client";

import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";

// Scroll-reveal wrapper: one IntersectionObserver per element, threshold 0.15,
// disconnect after first hit. Hidden state is inline opacity/transform, shown
// state is none + opacity 1, transition driven by --gr-delay for stagger.
export default function Reveal({
  children,
  className = "",
  delay = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "li" | "span" | "article";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const style: CSSProperties = shown
    ? { transition: "opacity 0.6s cubic-bezier(0.34, 1.3, 0.64, 1), transform 0.6s cubic-bezier(0.34, 1.3, 0.64, 1)" }
    : {
        opacity: 0,
        transform: "translateY(18px) scale(0.97)",
        transition: "opacity 0.6s cubic-bezier(0.34, 1.3, 0.64, 1), transform 0.6s cubic-bezier(0.34, 1.3, 0.64, 1)",
        transitionDelay: `${delay}ms`,
      };

  return (
    <Tag ref={ref as any} className={className} style={style}>
      {children}
    </Tag>
  );
}
