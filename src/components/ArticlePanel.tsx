import { useMemo } from "react";
import { api, fmt, cover as imageCover } from "../api";
import { handleArticleClick, sanitizeHtml } from "../html";
import { useSecurityUi, useStoreActions } from "../store";
import { IClose } from "../icons";

/* ================= 图文正文（吃瓜） ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast } = useStoreActions();
  const { strictSecurity } = useSecurityUi();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">图文详情</span>
        {hot ? <span className="text-[10.5px] text-mut">{fmt(hot)} 热度</span> : null}
        <button onClick={onClose} aria-label="关闭" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-6">
        {cover && <img src={imageCover(cover)} alt="" loading="lazy" decoding="async" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[12px] text-dim mt-4">这篇内容没有正文，可能只有图片或视频。</p>}
      </div>
    </div>
  );
}

export default ArticlePanel;
