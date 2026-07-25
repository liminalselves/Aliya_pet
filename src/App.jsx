import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Copy,
  FlipHorizontal2,
  LocateFixed,
  MousePointerClick,
  Move,
  Play,
  RefreshCw,
  Sparkles,
  Timer,
  WandSparkles,
} from "lucide-react";

const gestures = [
  { icon: MousePointerClick, name: "点击", detail: "说话并做随机动作" },
  { icon: Copy, name: "双击", detail: "切换小、标准、大尺寸" },
  { icon: Move, name: "拖动", detail: "移动并贴近屏幕边缘" },
  { icon: Timer, name: "长按", detail: "约 1.2 秒关闭宠物" },
];

const nativePet = window.AliyaNative;

export default function App() {
  const [character, setCharacter] = useState(() => nativePet?.getCharacter?.() ?? "Aliya");
  const [running, setRunning] = useState(() => nativePet?.isRunning?.() ?? false);
  const [autoAction, setAutoAction] = useState(true);
  const [mirrored, setMirrored] = useState(false);
  const [notice, setNotice] = useState("准备就绪");
  const [petMotion, setPetMotion] = useState({ key: 0, className: "pet-enter" });
  const swipeStartX = useRef(null);

  useEffect(() => {
    const syncRunning = (event) => setRunning(Boolean(event.detail));
    window.addEventListener("pet-running", syncRunning);
    return () => window.removeEventListener("pet-running", syncRunning);
  }, []);

  const characterImage = `${import.meta.env.BASE_URL}${
    character === "Aliya" ? "aliya_pet.png" : "windy_pet.png"
  }`;

  const quickActions = [
    {
      label: "随机动作",
      detail: "来点惊喜",
      icon: Sparkles,
      onClick: () => {
        setPetMotion(({ key }) => ({ key: key + 1, className: "pet-enter" }));
        setNotice(`${character} 做了一个随机动作`);
        nativePet?.performAction?.("random");
      },
    },
    {
      label: "切换自动",
      detail: autoAction ? "当前已开启" : "当前已关闭",
      icon: RefreshCw,
      active: autoAction,
      onClick: () => {
        setAutoAction((value) => !value);
        setNotice(`自动动作已${autoAction ? "关闭" : "开启"}`);
        nativePet?.performAction?.("auto");
      },
    },
    {
      label: "切换方向",
      detail: mirrored ? "面向左侧" : "面向右侧",
      icon: FlipHorizontal2,
      onClick: () => {
        setMirrored((value) => !value);
        setNotice("角色方向已切换");
        nativePet?.performAction?.("mirror");
      },
    },
    {
      label: "重置位置",
      detail: "回到右下角",
      icon: LocateFixed,
      onClick: () => {
        setNotice("位置已重置");
        nativePet?.performAction?.("reset");
      },
    },
  ];

  const selectCharacter = (next, className) => {
    setCharacter(next);
    setPetMotion(({ key }) => ({ key: key + 1, className }));
    nativePet?.setCharacter?.(next);
    setNotice(`已切换为 ${next}`);
  };

  const toggleCharacter = (className) =>
    selectCharacter(
      character === "Aliya" ? "Windy" : "Aliya",
      className ??
        (character === "Aliya" ? "pet-switch-from-right" : "pet-switch-from-left"),
    );

  const finishSwipe = (event) => {
    if (swipeStartX.current === null) return;
    const distance = event.clientX - swipeStartX.current;
    swipeStartX.current = null;
    if (distance <= -48) toggleCharacter("pet-switch-from-right");
    if (distance >= 48) toggleCharacter("pet-switch-from-left");
  };

  return (
    <main
      className={`app-theme theme-${character.toLowerCase()} relative min-h-dvh overflow-hidden px-4 pb-12 pt-[max(1.25rem,env(safe-area-inset-top))] text-[#161821]`}
    >
      <div className="ambient-orb ambient-orb-one" />
      <div className="ambient-orb ambient-orb-two" />
      <div className="orbital-line" />

      <section className="relative z-10 mx-auto w-full max-w-[430px]">
        <header className="animate-rise px-2 pt-4">
          <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.22em] text-slate-500">
            <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.75)]" />
            DESKTOP COMPANION
          </div>
          <h1 className="max-w-[390px] text-[42px] font-bold leading-[1.04] tracking-[-0.055em] text-[#101218]">
            让桌面宠物
            <br />
            陪你待在桌面。
          </h1>
          <p className="mt-4 max-w-[330px] text-[15px] leading-7 text-slate-500">
            一点陪伴，一点惊喜。随时互动，也安静地待在你身边。
          </p>
        </header>

        <section
          className="character-swipe animate-rise animation-delay-100 relative mt-4"
          aria-label="左右滑动切换人物"
          onPointerDown={(event) => {
            swipeStartX.current = event.clientX;
          }}
          onPointerUp={finishSwipe}
          onPointerCancel={() => {
            swipeStartX.current = null;
          }}
        >
          <div className="character-glow" />
          <div className="relative mx-auto flex h-[310px] items-end justify-center overflow-hidden">
            <div className="absolute bottom-6 h-12 w-52 rounded-[50%] bg-indigo-400/20 blur-xl" />
            <img
              key={petMotion.key}
              src={characterImage}
              alt={`${character} 桌面宠物`}
              draggable="false"
              className={`${petMotion.className} relative z-10 h-[292px] w-auto object-contain drop-shadow-[0_24px_24px_rgba(77,68,124,.2)] ${
                mirrored ? "-scale-x-100" : ""
              }`}
            />
          </div>
          <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/70 bg-white/45 px-3 py-1 text-[11px] font-semibold tracking-[0.12em] text-slate-600 shadow-sm backdrop-blur-xl">
            {character} · {running ? "ACTIVE" : "STANDBY"}
          </div>
        </section>

        <section className="animate-rise animation-delay-200 space-y-3">
          <button
            type="button"
            aria-pressed={running}
            onClick={() => {
              const next = !running;
              setRunning(next);
              nativePet?.setRunning?.(next);
              setNotice(next ? "桌面宠物已启动" : "桌面宠物已暂停");
            }}
            className="primary-button group flex w-full items-center justify-between rounded-[22px] px-5 py-[18px] text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70"
          >
            <span>
              <span className="block text-[17px] font-bold">
                {running ? "暂停桌面宠物" : "启动桌面宠物"}
              </span>
              <span className="primary-subtitle mt-0.5 block text-xs">
                {running ? "正在你的桌面陪伴" : "轻触即可开始陪伴"}
              </span>
            </span>
            <span className="grid size-11 place-items-center rounded-2xl bg-white/18 shadow-inner transition-transform group-active:scale-90">
              {running ? <CheckCircle2 size={22} /> : <Play size={22} fill="currentColor" />}
            </span>
          </button>

          <button
            type="button"
            onClick={toggleCharacter}
            className="glass glass-button flex w-full items-center justify-between rounded-[20px] px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/80"
          >
            <span>
              <span className="block text-[15px] font-bold text-slate-800">
                切换为 {character === "Aliya" ? "Windy" : "Aliya"}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">更换陪伴角色</span>
            </span>
            <RefreshCw size={20} className="theme-accent-text" />
          </button>
        </section>

        <section className="animate-rise animation-delay-300 mt-9">
          <div className="mb-4 flex items-end justify-between px-1">
            <div>
              <p className="theme-accent-muted text-[11px] font-bold tracking-[0.18em]">QUICK TOOLS</p>
              <h2 className="mt-1 text-[24px] font-bold tracking-[-0.035em]">快速操作</h2>
            </div>
            <span className="rounded-full bg-white/35 px-3 py-1.5 text-[11px] font-medium text-slate-500 backdrop-blur-md">
              {notice}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {quickActions.map(({ label, detail, icon: Icon, active, onClick }) => (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={onClick}
                className="glass glass-button group min-h-[112px] rounded-[22px] p-4 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/80"
              >
                <div className="flex h-full items-start justify-between gap-3">
                  <span className="self-end">
                    <span className="block text-[15px] font-bold text-slate-800">{label}</span>
                    <span className="mt-1 block text-[11px] text-slate-500">{detail}</span>
                  </span>
                  <span className="theme-accent-text grid size-10 shrink-0 place-items-center rounded-2xl border border-white/70 bg-white/50 shadow-[0_5px_14px_rgba(74,109,190,.12)] transition-transform group-hover:-translate-y-0.5 group-active:scale-90">
                    <Icon size={19} strokeWidth={2.2} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="glass animate-rise animation-delay-400 mt-8 rounded-[28px] p-5">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] text-indigo-500/70">GESTURES</p>
              <h2 className="mt-1 text-[23px] font-bold tracking-[-0.035em]">操作方式</h2>
            </div>
            <span className="grid size-11 place-items-center rounded-2xl border border-white/70 bg-white/45 text-indigo-600">
              <WandSparkles size={20} />
            </span>
          </div>

          <div className="divide-y divide-white/55">
            {gestures.map(({ icon: Icon, name, detail }) => (
              <div key={name} className="flex items-center gap-3 py-3.5 first:pt-0">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/48 text-slate-600 shadow-sm">
                  <Icon size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-[14px] font-bold text-slate-800">{name}</span>
                  <span className="ml-2 text-[12px] text-slate-500">{detail}</span>
                </span>
              </div>
            ))}
          </div>

          <p className="mt-4 border-t border-white/55 pt-4 text-center text-[10px] tracking-[0.06em] text-slate-400">
            位置、尺寸与开关状态会自动保存
          </p>
        </section>
      </section>
    </main>
  );
}
