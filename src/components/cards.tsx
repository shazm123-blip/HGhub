import { memo } from "react";
import { fmt } from "../api";
import { useVideoOrientation } from "../videoMeta";
import type { VideoCard } from "../types";
import { IHeartF, IPlayF } from "../icons";
import { Img } from "./ui";

/* ——— 画廊级瀑布流海报卡片（纯净高清封面 + 清晰下方排版） ——— */
export const WaterfallCard = memo(function WaterfallCard({ v, onOpen, eager = false }: {
  v: VideoCard; onOpen: (v: VideoCard) => void; eager?: boolean;
}) {
  const ori = useVideoOrientation(v.id);
  return (
    <button
      onClick={() => onOpen(v)}
      className="cv-card group text-left pressable block w-full">
      <div className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1">
        <Img
          src={v.cover}
          eager={eager}
          imgClassName="[@media(hover:hover)]:transition-transform [@media(hover:hover)]:duration-300 [@media(hover:hover)]:ease-out [@media(hover:hover)]:group-hover:scale-[1.04]"
        />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/65 via-black/15 to-transparent pointer-events-none" />
        {ori?.orientation === "landscape" && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-black/68 text-[10px] font-medium text-white/95 leading-tight">
            横屏
          </span>
        )}
        <span className={`absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold leading-tight ${v.is_finished ? "bg-black/68 text-white/95" : "brand-grad"}`}>
          {v.is_finished ? "已完结" : `${v.episode_count}集`}
        </span>
        <span className="absolute bottom-1.5 right-2 flex items-center gap-0.5 text-[10.5px] font-semibold text-white/92 tsh tabular-nums">
          <IPlayF size={9} />{fmt(v.hot)}
        </span>
      </div>
      <div className="pt-2 px-0.5">
        <div className="cover-title text-[13px] font-semibold text-on leading-snug clamp-2">{v.title}</div>
        <div className="flex items-center gap-1.5 mt-1 text-[11px] text-mut">
          <span className="truncate flex-1 min-w-0">{v.author?.name || "黄果短剧"}</span>
          {v.score > 0 ? (
            <span className="font-bold text-primary shrink-0 tabular-nums">★ {v.score.toFixed(1)}</span>
          ) : (
            <span className="flex items-center gap-0.5 shrink-0 tabular-nums text-dim"><IHeartF size={9} />{fmt(v.like_count)}</span>
          )}
        </div>
      </div>
    </button>
  );
});

/* ——— 画廊网格（避免 WebKit columns-2 卡片切半与重排跳动） ——— */
export const Masonry = memo(function Masonry({ videos, onOpen, wide = false, gap = "gap-3" }: {
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

/* ——— 分类横向画廊卡片 ——— */
export const RowCard = memo(function RowCard({ v, onOpen, eager = false }: { v: VideoCard; onOpen: (v: VideoCard) => void; eager?: boolean }) {
  const ori = useVideoOrientation(v.id);
  return (
    <button onClick={() => onOpen(v)} className="row-cover w-[112px] shrink-0 text-left snap-start pressable group">
      <div className="cover-frame relative w-full aspect-[3/4] rounded-(--r-sm) overflow-hidden bg-s1">
        <Img
          src={v.cover}
          eager={eager}
          imgClassName="[@media(hover:hover)]:transition-transform [@media(hover:hover)]:duration-300 [@media(hover:hover)]:ease-out [@media(hover:hover)]:group-hover:scale-[1.04]"
        />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/62 to-transparent pointer-events-none" />
        {ori?.orientation === "landscape" && (
          <span className="absolute top-1.5 left-1.5 px-1 py-0.5 rounded bg-black/68 text-[9.5px] font-medium text-white/95 leading-tight">
            横屏
          </span>
        )}
        <span className={`absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md text-[9.5px] font-semibold leading-tight ${v.is_finished ? "bg-black/68 text-white/95" : "brand-grad"}`}>
          {v.is_finished ? "已完结" : `${v.episode_count}集`}
        </span>
        <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 text-[10px] font-semibold text-white/92 tsh tabular-nums">
          <IPlayF size={9} />{fmt(v.hot)}
        </span>
      </div>
      <div className="mt-2 cover-title text-[12.5px] font-semibold text-on clamp-1 leading-tight">{v.title}</div>
      <div className="text-[11px] text-mut clamp-1 mt-0.5">{v.tags?.slice(0, 2).join(" · ") || (v.score > 0 ? `${v.score.toFixed(1)}分` : "推荐")}</div>
    </button>
  );
});

/* ——— 排行榜条目（Top 3 金银铜领奖台卡片 + 第 4 名起精致紧凑行） ——— */
export type RankRowItem = { rank: number; video_id: number; title: string; cover: string; tags: string[]; score: number; metric_value: number; metric_label: string };
export const RankRow = memo(function RankRow({ item, onOpen, metricMax }: {
  item: RankRowItem;
  onOpen: (item: RankRowItem) => void;
  metricMax: number;
}) {
  const ori = useVideoOrientation(item.video_id);
  const i = item.rank - 1;
  const podium = i < 3;
  const badgeClass = i === 0 ? "rank-badge-1" : i === 1 ? "rank-badge-2" : i === 2 ? "rank-badge-3" : "text-dim font-semibold";
  const pct = Math.max(8, Math.round((item.metric_value / Math.max(1, metricMax)) * 100));

  if (podium) {
    return (
      <button
        onClick={() => onOpen(item)}
        className="w-full flex items-center gap-3 p-3 rounded-(--r-md) text-left mb-2.5 pressable a-rise rank-podium-card"
        style={{ animationDelay: `${i * 40}ms` }}>
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-[13px] font-extrabold shrink-0 tabular-nums ${badgeClass}`}>
          {item.rank}
        </span>
        <div className="cover-frame relative w-[54px] h-[72px] rounded-lg overflow-hidden bg-s3 shrink-0">
          <Img src={item.cover} eager />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-on clamp-2 leading-snug">{item.title}</div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[11px] text-mut truncate">{item.tags?.slice(0, 2).join(" · ")}</span>
            {ori?.orientation === "landscape" && <span className="shrink-0 px-1.5 py-0.5 rounded bg-s3 text-[9.5px] text-mut leading-none">横屏</span>}
          </div>
          <div className="flex items-center gap-2.5 mt-2">
            {item.score > 0 && <span className="shrink-0 text-[11px] font-bold text-primary tabular-nums">★ {item.score.toFixed(1)}分</span>}
            <div className="flex-1 h-[3px] rounded-full bg-s3 overflow-hidden">
              <div className="h-full rounded-full brand-grad" style={{ width: `${pct}%` }} />
            </div>
            <span className="shrink-0 text-[10.5px] font-semibold text-mut tabular-nums">{fmt(item.metric_value)}</span>
          </div>
        </div>
      </button>
    );
  }

  return (
    <button
      onClick={() => onOpen(item)}
      className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-(--r-md) text-left pressable hover:bg-s1/80 transition-colors">
      <span className="w-7 text-center text-[13px] font-semibold text-dim shrink-0 tabular-nums">{item.rank}</span>
      <div className="cover-frame relative w-[46px] h-[62px] rounded-lg overflow-hidden bg-s2 shrink-0">
        <Img src={item.cover} eager={i < 6} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium text-on clamp-1 leading-snug">{item.title}</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[11px] text-mut truncate">{item.tags?.slice(0, 2).join(" · ")}</span>
          {ori?.orientation === "landscape" && <span className="shrink-0 px-1.5 py-0.5 rounded bg-s3 text-[9.5px] text-mut leading-none">横屏</span>}
        </div>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-0.5 tabular-nums">
        {item.score > 0 && <span className="text-[11.5px] font-bold text-primary">★ {item.score.toFixed(1)}</span>}
        <span className="text-[10.5px] text-mut">{fmt(item.metric_value)}</span>
      </div>
    </button>
  );
});
