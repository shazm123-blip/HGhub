import { useState } from "react";
import { api, getApiBase, isFixedLine, isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, SegmentedControl, Sheet } from "./ui";
import { IClose, IEye, IEyeOff, ILogin } from "../icons";

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setLinePickerOpen, prepareLogin, toast } = useStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const mirrorLine = loginOpen && !isFixedLine(getApiBase());

  const submit = async () => {
    if (!username.trim() || !password) { setErr("请输入账号与密码"); return; }
    setBusy(true);
    setErr("");
    const completeLogin = prepareLogin();
    try {
      const res = mode === "login"
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password, email.trim());
      const nextUser = res.user as User;
      completeLogin(nextUser);
      setPassword("");
      setLoginOpen(false);
      toast(mode === "login" ? `欢迎回来，${nextUser?.nickname || username}` : "注册成功", "ok");
    } catch (e) {
      setErr((e as Error).message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  /* 移动端用底部抽屉，桌面端用居中弹窗 */
  const body = (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="shrink-0 w-8 h-8 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ILogin size={16} /></span>
        <span className="text-[15px] font-bold text-on">{mode === "login" ? "登录 HGhub" : "注册 HGhub"}</span>
        <button onClick={() => setLoginOpen(false)} aria-label="关闭" className="ml-auto shrink-0 w-7 h-7 rounded-full bg-s4 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>

      {mirrorLine && (
        <div className="mb-3 rounded-(--r-sm) bg-amber/12 border border-amber/25 px-3 py-2 flex items-center gap-2">
          <span className="text-[11px] text-on/85 leading-snug flex-1">
            当前为镜像线路，仅支持游客浏览；如需登录请先切回固定线路。
          </span>
          <button type="button" onClick={() => { setLoginOpen(false); setLinePickerOpen(true); }}
            className="shrink-0 px-2.5 h-7 rounded-full bg-primary text-on-primary text-[11px] font-semibold pressable">
            去切换
          </button>
        </div>
      )}

      <SegmentedControl
        className="mb-3"
        ariaLabel="账号操作"
        value={mode}
        onChange={(k) => { setMode(k); setErr(""); }}
        options={[{ value: "login", label: "登录" }, { value: "register", label: "注册" }]}
      />

      <form className="flex flex-col gap-2.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="账号"
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className={`h-10 px-3.5 rounded-(--r-sm) bg-s4 ${isMobile ? "text-[16px]" : "text-[13px]"} text-on placeholder-mut outline-none focus:ring-2 focus:ring-[var(--p-primary)]`} />
        <div className="relative flex items-center">
          <input value={password} onChange={(e) => setPassword(e.target.value)} type={showPass ? "text" : "password"} placeholder="密码"
            className={`w-full h-10 pl-3.5 pr-10 rounded-(--r-sm) bg-s4 ${isMobile ? "text-[16px]" : "text-[13px]"} text-on placeholder-mut outline-none focus:ring-2 focus:ring-[var(--p-primary)]`} />
          <button type="button" aria-label={showPass ? "隐藏密码" : "显示密码"} onClick={() => setShowPass((v) => !v)}
            className="absolute right-2 w-7 h-7 rounded-full flex items-center justify-center text-mut hover:text-on pressable">
            {showPass ? <IEyeOff size={16} /> : <IEye size={16} />}
          </button>
        </div>
        {mode === "register" && (
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱（可选）"
            type="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            className={`h-10 px-3.5 rounded-(--r-sm) bg-s4 ${isMobile ? "text-[16px]" : "text-[13px]"} text-on placeholder-mut outline-none focus:ring-2 focus:ring-[var(--p-primary)]`} />
        )}
        {err && <div className="text-[11.5px] text-danger">{err}</div>}
        <button type="submit" disabled={busy}
          className="h-10 rounded-(--r-ctl) bg-primary text-on-primary text-[13px] font-bold pressable disabled:opacity-60">
          {busy ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
        </button>
      </form>
      <p className="text-[11px] text-dim mt-3 leading-relaxed">
        使用黄果短剧官网账号登录。登录、注册仅支持固定线路；镜像线路请以游客浏览。
      </p>
    </div>
  );

  return isMobile
    ? <Sheet open={loginOpen} onClose={() => setLoginOpen(false)} z="z-[60]">{body}</Sheet>
    : <Modal open={loginOpen} onClose={() => setLoginOpen(false)} width={360}>{body}</Modal>;
}
