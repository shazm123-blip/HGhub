import { memo } from "react";
import { fmt } from "../api";
import { useVideoOrientation } from "../videoMeta";
import type { VideoCard } from "../types";
import { IHeartF, IPlayF } from "../icons";
import { Img } from "./ui";

/* ——— 瀑布流卡片 ——— */
export const WaterfallCard = memo(function WaterfallCard({ v, onOpen, eager = false }: {
  v: VideoCard; onOpen: (v: VideoCard) => void; eager?: boolean;
}) {
  const ori = useVideoOrientation(v.id);
  return (
    <button onClick={() => onOpen(v)}
      className="cv-card group cover-frame relative w-full aspect-[100/132] overflow-hidden text-left bg-s1 elev-1 pressable block rounded-(--r-sm)">
      <Img src={v.cover} eager={eager} imgClassName="[@media(hover:hover)]:transition-transform [@media(hover:hover)]:duration-300 [@media(hover:hover)]:ease-out [@media(hover:hover)]:group-hover:scale-[1.04]" />
      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
        <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold brand-grad elev-1 leading-tight">
          {v.is_finished ? "已完结" : `更新至${v.episode_count}集`}
        </span>
        {ori?.orientation === "landscape" && (
          <span className="px-1.5 py-0.5 rounded-md bg-black/65 text-[10px] font-medium text-white/95 leading-tight">
            横屏
          </span>
        )}
      </div>
      <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-black/60 text-[10px] font-semibold text-white/90 leading-tight">
        <IPlayF size={9} />{fmt(v.hot)}
      </span>
      <div className="absolute inset-x-0 bottom-0 p-2">
        <div className="cover-title text-[12px] font-medium text-white leading-snug clamp-2 tsh">{v.title}</div>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-[10px] text-white/65 truncate flex-1 min-w-0">{v.author?.name || "黄果短剧"}</span>
          {v.score > 0 && <span className="text-[10px] font-bold hg-gold shrink-0 tabular-nums">{v.score.toFixed(1)}分</span>}
          <span className="flex items-center gap-0.5 text-[10px] text-white/75 shrink-0 tabular-nums"><IHeartF size={10} className="text-white/70" />{fmt(v.like_count)}</span>
        </div>
      </div>
    </button>
  );
});

/* ——— 网格瀑布流（避免 WebKit columns-2 卡片切半与重排跳动） ——— */
export const Masonry = memo(function Masonry({ videos, onOpen, wide = false, gap = "gap-1.5" }: {
  videos: VideoCard[]; onOpen: (v: VideoCard) => void; wide?: boolean; gap?: string;
}) {
  return (
    <div className={`grid ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"} ${gap}`}>
      {videos.map((v, idx) => (
        <WaterfallCard key={v.id} v={v} eager={idx < 6} onOpen={onOpen} />
      ))}
    </div>
  );
});

/* ——— 分类横向卡片 ——— */
export const RowCard = memo(function RowCard({ v, onOpen, eager = false }: { v: VideoCard; onOpen: () => void; eager?: boolean }) {
  const ori = useVideoOrientation(v.id);
  return (
    <button onClick={onOpen} className="row-cover w-[108px] shrink-0 text-left snap-start pressable group">
      <div className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1 elev-1">
        <Img src={v.cover} eager={eager} imgClassName="[@media(hover:hover)]:transition-transform [@media(hover:hover)]:duration-300 [@media(hover:hover)]:ease-out [@media(hover:hover)]:group-hover:scale-[1.04]" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75 to-transparent" />
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-[9.5px] font-bold brand-grad leading-tight">
          {v.is_finished ? "完结" : `${v.episode_count}集`}
        </span>
        {ori?.orientation === "landscape" && (
          <span className="absolute top-1.5 right-1.5 px-1 py-0.5 rounded bg-black/65 text-[9.5px] font-medium text-white/95 leading-tight">
            横屏
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 text-[10px] font-semibold text-white/90 tsh"><IPlayF size={9} />{fmt(v.hot)}</span>
      </div>
      <div className="mt-1.5 cover-title text-[12px] font-medium text-on clamp-1 leading-tight">{v.title}</div>
      <div className="text-[10.5px] text-mut clamp-1 mt-0.5">{v.tags?.slice(0, 2).join(" · ")}</div>
    </button>
  );
});

/* ——— 排行榜条目 ——— */
export const RankRow = memo(function RankRow({ item, onOpen, metricMax }: {
  item: { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; metric_value: number; metric_label: string };
  onOpen: () => void; metricMax: number;
}) {
  const ori = useVideoOrientation(item.video_id);
  const i = item.rank - 1;
  return (
    <button onClick={onOpen}
      className={`w-full flex items-center gap-3 p-2.5 rounded-(--r-md) text-left mb-2 pressable a-rise ${i < 3 ? "bg-s3" : "bg-s2"}`}
      style={{ animationDelay: `${Math.min(i * 35, 300)}ms` }}>
      <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 tabular-nums ${i === 0 ? "bg-primary text-on-primary" : i < 3 ? "tonal" : "text-dim"}`}>{item.rank}</span>
      <div className="cover-frame relative w-[52px] h-[68px] rounded-lg overflow-hidden bg-s3 shrink-0">
        <Img src={item.cover} eager={i < 6} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-on clamp-2 leading-snug">{item.title}</div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10.5px] text-mut truncate">{item.tags?.slice(0, 2).join(" · ")}</span>
          {ori?.orientation === "landscape" && <span className="shrink-0 px-1.5 py-0.5 rounded bg-s4 text-[9.5px] text-mut leading-none">横屏</span>}
          {item.score > 0 && <span className="shrink-0 text-[10.5px] font-semibold text-amber tabular-nums">{item.score.toFixed(1)}分</span>}
          <span className="shrink-0 ml-auto flex items-center gap-0.5 text-[10.5px] font-bold text-primary tabular-nums">{fmt(item.metric_value)}</span>
        </div>
        <div className="mt-1.5 h-[3px] rounded-full bg-s4 overflow-hidden">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(6, Math.round((item.metric_value / Math.max(1, metricMax)) * 100))}%` }} />
        </div>
      </div>
    </button>
  );
});