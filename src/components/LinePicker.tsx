import { useEffect, useMemo, useRef, useState } from "react";
import { api, hostOf, isMobile, setApiBase, type LineItem, type LineProbe, type LineState } from "../api";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { IBoltF, ICheck, IClose, IRefresh, ISettings } from "../icons";

type ProbeMap = Record<string, LineProbe>;

/* 单条线路：左侧点一下即切换，右侧单独检测 */
function Row({ item, current, probe, busy, switching, onPick, onProbe }: {
  item: LineItem; current: boolean; probe?: LineProbe; busy: boolean; switching: boolean;
  onPick: (url: string) => void; onProbe: (url: string) => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-3.5 py-2.5 ${current ? "bg-s3/70" : ""}`}>
      <button onClick={() => onPick(item.url)} disabled={switching} className="flex-1 min-w-0 text-left pressable disabled:opacity-60">
        <div className="flex items-center gap-1.5 text-[12.5px] text-on">
          <span className="truncate">{item.name || item.host || hostOf(item.url)}</span>
          {current && <ICheck size={13} className="text-mint shrink-0" />}
        </div>
        <div className="text-[10.5px] text-mut truncate mt-0.5">{item.url}</div>
      </button>
      <span
        title={probe ? (probe.error || (probe.status ? `HTTP ${probe.status}` : "")) : ""}
        className={`text-[11px] tabular-nums shrink-0 ${probe ? (probe.ok ? "text-mint font-semibold" : "text-danger") : "text-dim"}`}>
        {busy ? "测速中…" : probe ? (probe.ok ? `${probe.ms}ms` : probe.status ? `HTTP ${probe.status}` : "失败") : "—"}
      </span>
      <button onClick={() => onProbe(item.url)} disabled={busy || switching}
        className="shrink-0 h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[11px] text-on/80 pressable disabled:opacity-50">检测</button>
    </div>
  );
}

/* 线路选择：桌面居中弹窗，移动端底部抽屉 */
export default function LinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, user, setUser, bumpLineVersion } = useStore();
  const [state, setState] = useState<LineState | null>(null);
  const [mirrors, setMirrors] = useState<LineItem[] | null>(null);
  const [mirrorErr, setMirrorErr] = useState("");
  const [loadingMirrors, setLoadingMirrors] = useState(false);
  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState("");
  const [probingBatch, setProbingBatch] = useState(false);
  const [sortBySpeed, setSortBySpeed] = useState(false);
  const [switching, setSwitching] = useState("");
  const probeRunRef = useRef(0);

  const readState = () => {
    api.lineState().then(setState).catch((e) => toast((e as Error).message || "读取线路失败", "info"));
  };

  const readMirrors = async () => {
    setLoadingMirrors(true);
    setMirrorErr("");
    try {
      const res = await api.lineMirrors();
      setMirrors(res?.items || []);
    } catch (e) {
      setMirrors([]);
      setMirrorErr((e as Error).message || "镜像线路获取失败");
    } finally {
      setLoadingMirrors(false);
    }
  };

  const stopProbing = () => {
    probeRunRef.current += 1;
    setProbing("");
    setProbingBatch(false);
  };

  /* 镜像线路只在用户点开「线路」后才去拉，拉过一次就留在内存里，可手动刷新 */
  useEffect(() => {
    if (!open) {
      stopProbing();
      return;
    }
    readState();
    if (mirrors === null) void readMirrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const probe = async (list: LineItem[], key: string) => {
    if (!list.length) return;
    const runId = ++probeRunRef.current;
    const isBatch = key === "fixed" || key === "mirrors";
    setProbing(key);
    setProbingBatch(isBatch);
    try {
      for (let i = 0; i < list.length; i += 6) {
        if (probeRunRef.current !== runId) return;
        const chunk = list.slice(i, i + 6).map((x) => x.url);
        const res = await api.lineProbe(chunk);
        if (probeRunRef.current !== runId) return;
        setProbes((p) => {
          const next = { ...p };
          for (const r of res) next[r.url] = r;
          return next;
        });
      }
      if (isBatch && probeRunRef.current === runId) setSortBySpeed(true);
    } catch (e) {
      if (probeRunRef.current === runId) toast((e as Error).message || "检测失败", "info");
    } finally {
      if (probeRunRef.current === runId) {
        setProbing("");
        setProbingBatch(false);
      }
    }
  };

  const pick = async (url: string) => {
    if (switching || state?.base === url) return;
    stopProbing();
    setSwitching(url);
    const wasLoggedIn = !!user;
    try {
      const next = await api.lineSet(url);
      setApiBase(next);
      if (next !== state?.base) {
        setUser(null);
        bumpLineVersion();
      }
      setState((s) => (s ? { ...s, base: next } : s));
      toast(
        wasLoggedIn
          ? `线路已切换到 ${hostOf(next)}，跨站点需重新登录`
          : `线路已切换到 ${hostOf(next)}`,
        "ok",
      );
    } catch (e) {
      toast((e as Error).message || "切换失败", "info");
    } finally {
      setSwitching("");
    }
  };

  const fixed = state?.fixed || [];
  const fastest = useMemo(() => {
    const all = [...fixed, ...(mirrors || [])];
    let best: { item: LineItem; ms: number } | null = null;
    for (const it of all) {
      const pr = probes[it.url];
      if (pr?.ok && (!best || pr.ms < best.ms)) best = { item: it, ms: pr.ms };
    }
    return best;
  }, [fixed, mirrors, probes]);

  const sortedMirrors = useMemo(() => {
    const list = mirrors || [];
    if (!sortBySpeed) return list;
    return [...list].sort((a, b) => {
      const pa = probes[a.url];
      const pb = probes[b.url];
      const rank = (p?: LineProbe) => (p ? (p.ok ? p.ms : 1_000_000) : 500_000);
      return rank(pa) - rank(pb);
    });
  }, [mirrors, probes, sortBySpeed]);

  const body = (
    <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "74dvh" : "min(72vh, 620px)" }}>
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="shrink-0 w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ISettings size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-on leading-tight">线路</div>
          <div className="text-[11px] text-mut mt-0.5 truncate">当前：{state ? hostOf(state.base) : "读取中…"}</div>
        </div>
        {fastest && state?.base !== fastest.item.url && (
          <button onClick={() => void pick(fastest.item.url)} disabled={!!switching}
            className="shrink-0 px-2.5 h-7 rounded-full bg-primary text-on-primary text-[11px] font-semibold flex items-center gap-1 pressable">
            <IBoltF size={11} />用最快 ({fastest.ms}ms)
          </button>
        )}
        <button onClick={onClose} aria-label="关闭" className="shrink-0 w-8 h-8 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable"><IClose size={16} /></button>
      </div>

      <div className="flex-1 scroll-y px-3 pb-4">
        <div className="flex items-center gap-2 px-1 mt-1 mb-1.5">
          <span className="text-[11px] font-semibold text-dim tracking-wide">固定线路</span>
          <span className="text-[10.5px] text-dim">支持登录 · 需代理或非大陆网络</span>
          {probing === "fixed" ? (
            <button onClick={stopProbing} className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-danger pressable">停止检测</button>
          ) : (
            <button onClick={() => void probe(fixed, "fixed")} disabled={!!switching || probingBatch || !fixed.length}
              className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-primary pressable disabled:opacity-50">
              全部检测
            </button>
          )}
        </div>
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {fixed.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} switching={!!switching} onPick={pick} onProbe={(u) => void probe([{ url: u }], u)} />
          ))}
          {!fixed.length && <div className="px-3.5 py-3 text-[11px] text-mut">读取中…</div>}
        </div>

        <div className="flex items-center gap-2 px-1 mt-4 mb-1.5">
          <span className="text-[11px] font-semibold text-dim tracking-wide">镜像线路</span>
          <span className="text-[10.5px] text-dim">一般可直连 · 仅游客浏览</span>
          <div className="ml-auto flex items-center gap-2.5">
            {!!mirrors?.length && Object.keys(probes).length > 0 && (
              <button onClick={() => setSortBySpeed((v) => !v)}
                className={`text-[11px] pressable ${sortBySpeed ? "text-primary font-semibold" : "text-mut"}`}>
                {sortBySpeed ? "已按延迟排序" : "按延迟排序"}
              </button>
            )}
            <button onClick={() => { void readMirrors(); }} disabled={loadingMirrors}
              className="shrink-0 whitespace-nowrap inline-flex items-center gap-1 text-[11px] text-primary pressable disabled:opacity-50">
              <IRefresh size={12} />{loadingMirrors ? "获取中…" : "刷新"}
            </button>
          </div>
        </div>
        <div className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><div className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && mirrorErr && (
            <div className="px-3.5 py-3">
              <div className="text-[11.5px] text-danger">镜像线路获取失败</div>
              <div className="text-[10.5px] text-mut mt-1 break-all">{mirrorErr}</div>
            </div>
          )}
          {!loadingMirrors && !mirrorErr && mirrors?.length === 0 && (
            <div className="px-3.5 py-3 text-[11px] text-mut">地址发布页里没有可用的镜像地址</div>
          )}
          {!loadingMirrors && sortedMirrors.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} switching={!!switching} onPick={pick} onProbe={(u) => void probe([{ url: u }], u)} />
          ))}
        </div>
        {!loadingMirrors && !!mirrors?.length && (
          <div className="flex justify-end px-1 mt-2">
            {probing === "mirrors" ? (
              <button onClick={stopProbing} className="text-[11px] text-danger pressable">停止检测</button>
            ) : (
              <button onClick={() => void probe(mirrors, "mirrors")} disabled={!!switching || probingBatch}
                className="text-[11px] text-primary pressable disabled:opacity-50">
                全部检测（{mirrors.length}）
              </button>
            )}
          </div>
        )}

        <div className="text-[10.5px] text-dim leading-relaxed px-1 mt-4">
          检测过程中也可直接点击任意已测出绿色延迟的线路立即切换。不做自动检测与后台轮询，只有点「检测」时才探测。
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={onClose} z="z-50">{body}</Sheet>
    : <Modal open={open} onClose={onClose} width={460}>{body}</Modal>;
}
