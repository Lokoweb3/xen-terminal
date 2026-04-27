import { useState, useEffect, useCallback, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";

// ── Constants ─────────────────────────────────────────────────
// OG XEN ecosystem (Ethereum fork copy, same addresses as mainnet)
const XEN_ADDRESS      = "0x8a7FDcA264e87b6da72D000f22186B4403081A2a"; // OG pXEN token (ERC-20)
const XENFT_ADDRESS    = "0x0a252663DBCc0b073063D6420a40319e438Cfa59"; // OG XENFT (ERC-721)
// Native PulseChain XEN ecosystem (new deployment)
const NATIVE_XEN       = "0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8"; // Native XEN token (ERC-20)
const NATIVE_XENFT     = "0xfEa13BF27493f04DEac94f67a46441a68EfD32F8"; // Native XENFT (ERC-721)

const PULSE_RPC        = "https://rpc.pulsechain.com";
const CHAIN_HEX        = "0x171";
const PULSE_NETWORK = {
  chainId:CHAIN_HEX, chainName:"PulseChain",
  nativeCurrency:{name:"Pulse",symbol:"PLS",decimals:18},
  rpcUrls:[PULSE_RPC], blockExplorerUrls:["https://scan.pulsechain.com"],
};
const GRACE_DAYS    = 7;  // XEN grace period before rewards drop
const PROXY_BATCH   = 20; // load proxies in batches of 20

// ── Known XenMintManager deployments ─────────────────────────
// Listed in dashboard quick-switch UI. V3 is the active default.
// Known XenMintManager deployments. Order matters — the first entry is
// the default, the second/third are the quick-switch alternates.
// V4 is the audited default. V3/V2 have a fund-locking bug (V-01) that
// traps any harvested pXEN inside the contract — keep them listed for
// historical access but DO NOT mint on them.
const KNOWN_CONTRACTS = [
  { label:"V4", version:"V4", address:"0x8BfFebfFf72b6F45D7eAa79F43A82587254Bdcec", note:"Audit-fixed (active)" },
  { label:"V3", version:"V3", address:"0x80cBa50Fe0Efe7Fd98CbDe0a290A6651fAD0bDAF", note:"EIP-1167 clones — V-01 bug" },
  { label:"V2", version:"V2", address:"0x8F3b672F0e223d105cE90e38665e7aD05e0bEEe4", note:"Legacy — V-01 bug" },
];
const DEFAULT_MANAGER = KNOWN_CONTRACTS[0].address;

// Relayer wallet — used by the gas-tracking scan so its tx history
// shows up in "Spent (gas)" alongside the connected owner wallet.
const RELAYER_WALLET = "0x02F31836423Eba5f6bD52B8d7dD4488E1De0355e";

// ── Colors ────────────────────────────────────────────────────
const C = { cyan:"#00f5ff", pink:"#ff2d78", green:"#00ff88", amber:"#ffb800", purple:"#a855f7" };
const statusColor = s => ({ READY:C.green, SOON:C.amber, MINTING:C.cyan }[s]||"#666");
const statusBg    = s => ({ READY:"rgba(0,255,136,0.08)", SOON:"rgba(255,184,0,0.08)", MINTING:"rgba(0,245,255,0.06)" }[s]||"transparent");
const short = a => a?`${a.slice(0,6)}...${a.slice(-4)}`:"—";
const fmtN  = n => { try{return parseInt(String(n).replace(/,/g,"")).toLocaleString();}catch{return String(n||"0");} };

// ── ABI helpers ───────────────────────────────────────────────
const pad32 = n => BigInt(n).toString(16).padStart(64,"0");
const SELS  = {
  "proxyCount()":                                    "37c954d8",
  "maturedCount()":                                  "9db85c8a",
  "maturingSoon(uint256)":                           "d5517948",
  "getMaturity(uint256)":                            "7f1e7d41",
  "owner()":                                         "8da5cb5b",
  "batchClaimRank(uint256,uint256)":                 "bb739814",
  "batchClaim(uint256,uint256)":                     "50416b93",
  "batchClaimStakeAndRestart(uint256,uint256,bool)": "05e98d64",
  "balanceOf(address)":                              "70a08231",
  "addSessionKey(address,uint256,uint256,bool)":     "ac5d53b0",
  "delegateToRelayer(address,uint256)":              "5f0f0030",
  // XENFT
  "bulkClaimRank(uint256,uint256)":                  "ecef9201",
  // OG XENT and pXENT both use the 2-arg version on PulseChain.
  // Selector verified against on-chain tx 0x921edb5e1358e5...
  "bulkClaimMintReward(uint256,address)":            "f5878b9b",
  "tokenOfOwnerByIndex(address,uint256)":            "2f745c59",
  "ownerOf(uint256)":                                "6352211e",
  "vmuCount(uint256)":                               "a1a53fa1",
  "mintInfo(uint256)":                               "443aa533",
};
const sel = s => SELS[s]||"00000000";
async function ethCall(to,sig,params=[]) {
  let data = "0x"+sel(sig);
  for (const p of params) {
    if      (typeof p==="boolean")               data+=pad32(p?1:0);
    else if (typeof p==="string"&&p.startsWith("0x")) data+=p.slice(2).padStart(64,"0");
    else                                          data+=pad32(p);
  }
  const r = await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to,data},"latest"]})});
  return (await r.json()).result;
}
const decodeUint = h => h&&h!=="0x"?parseInt(h,16):0;
const decodeAddr = h => h&&h.length>=66?"0x"+h.slice(26):null;

// ── Demo data ─────────────────────────────────────────────────
const mkDemoProxies = () => Array.from({length:50},(_,i)=>{
  const daysLeft = i<7?0:i<12?Math.floor(Math.random()*8)+1:Math.floor(Math.random()*100)+10;
  const ts = Math.floor(Date.now()/1000)+daysLeft*86400;
  return { id:i, daysLeft, matured:daysLeft===0, maturityTs:ts,
    maturityDate:new Date(ts*1000).toLocaleDateString(),
    graceExpiry: new Date((ts+GRACE_DAYS*86400)*1000),
    estimatedXen: Math.floor(Math.random()*50000+5000),
    status:daysLeft===0?"READY":daysLeft<10?"SOON":"MINTING" };
});
const DEMO_CD       = {totalProxies:50,maturedCount:7,maturingSoon:12,owner:"0xdEaD...C0fFe"};
const DEMO_PROXIES  = mkDemoProxies();
const DEMO_ANALYTICS= {
  totalEarned:1087163, totalGasPls:4.82, claimCount:4,
  chartData:[
    {day:"Mar 1",xen:98123,gas:1.1},{day:"Mar 13",xen:184293,gas:0.9},
    {day:"Mar 21",xen:291847,gas:1.4},{day:"Apr 2",xen:512900,gas:1.42},
  ],
};
const DEMO_XENFTS = [
  {tokenId:1042, vmus:100, term:100, daysLeft:0,  matured:true,  maturityDate:"Apr 5, 2026",  graceExpiry:new Date(Date.now()+2*86400000), estXen:142000},
  {tokenId:1043, vmus:50,  term:100, daysLeft:6,  matured:false, maturityDate:"Apr 24, 2026", graceExpiry:new Date(Date.now()+13*86400000), estXen:71000},
  {tokenId:1044, vmus:128, term:180, daysLeft:44, matured:false, maturityDate:"Jun 1, 2026",  graceExpiry:new Date(Date.now()+51*86400000), estXen:230000},
  {tokenId:1045, vmus:75,  term:100, daysLeft:82, matured:false, maturityDate:"Jul 9, 2026",  graceExpiry:new Date(Date.now()+89*86400000), estXen:107000},
];

// ── Hooks ─────────────────────────────────────────────────────
function useWidth() {
  const [w,setW]=useState(typeof window!=="undefined"?window.innerWidth:700);
  useEffect(()=>{const h=()=>setW(window.innerWidth);window.addEventListener("resize",h);return()=>window.removeEventListener("resize",h);},[]);
  return w;
}
function Counter({to,duration=1400}){
  const [val,setVal]=useState(0);
  useEffect(()=>{
    const t=parseInt(String(to).replace(/,/g,""))||0,s=Date.now();
    const tick=()=>{const p=Math.min(1,(Date.now()-s)/duration);setVal(Math.floor((1-Math.pow(1-p,4))*t));if(p<1)requestAnimationFrame(tick);};
    requestAnimationFrame(tick);
  },[to]);
  return <>{val.toLocaleString()}</>;
}

// ── UI primitives ─────────────────────────────────────────────
function HexGrid(){
  return(
    <svg style={{position:"fixed",inset:0,width:"100%",height:"100%",opacity:0.033,pointerEvents:"none"}} xmlns="http://www.w3.org/2000/svg">
      <defs><pattern id="hex" x="0" y="0" width="60" height="52" patternUnits="userSpaceOnUse">
        <polygon points="15,2 45,2 58,25 45,48 15,48 2,25" fill="none" stroke="#00f5ff" strokeWidth="0.7"/>
      </pattern></defs>
      <rect width="100%" height="100%" fill="url(#hex)"/>
    </svg>
  );
}
function GlowCard({children,color=C.cyan,style={}}){
  const [hov,setHov]=useState(false);
  return(
    <div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)} style={{
      background:"rgba(0,5,20,0.82)",border:`1px solid ${color}${hov?"55":"22"}`,
      backdropFilter:"blur(16px)",boxShadow:hov?`0 0 32px ${color}18,inset 0 0 32px ${color}06`:"none",
      transition:"all 0.3s",position:"relative",overflow:"hidden",...style,
    }}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${color}${hov?"bb":"44"},transparent)`}}/>
      {children}
    </div>
  );
}
function StatCard({label,value,sub,icon,color=C.cyan,animate=false}){
  return(
    <GlowCard color={color} style={{padding:"16px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:9,letterSpacing:"0.15em",color:`${color}77`,textTransform:"uppercase",marginBottom:8}}>{label}</div>
          <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:26,fontWeight:700,color:"#fff",lineHeight:1,textShadow:`0 0 20px ${color}55`}}>
            {animate&&typeof value==="number"?<Counter to={value}/>:value}
          </div>
          {sub&&<div style={{fontSize:10,color:`${color}aa`,marginTop:6,lineHeight:1.3}}>{sub}</div>}
        </div>
        <div style={{fontSize:18,opacity:0.4,marginLeft:6,flexShrink:0}}>{icon}</div>
      </div>
      <div style={{position:"absolute",bottom:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${color}33,transparent)`}}/>
    </GlowCard>
  );
}
function NeonBtn({children,color=C.cyan,onClick,disabled,full,small}){
  const [hov,setHov]=useState(false);
  return(
    <button onClick={onClick} disabled={disabled}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{width:full?"100%":"auto",padding:small?"6px 10px":"10px 12px",
        background:hov?`${color}14`:"transparent",border:`1px solid ${color}${hov?"88":"33"}`,
        color:hov?"#fff":`${color}bb`,fontSize:small?8:10,letterSpacing:"0.06em",
        cursor:disabled?"not-allowed":"pointer",fontFamily:"inherit",textTransform:"uppercase",
        boxShadow:hov?`0 0 20px ${color}22,inset 0 0 20px ${color}08`:"none",
        transition:"all 0.2s",opacity:disabled?0.4:1,textAlign:"center",whiteSpace:"nowrap",
      }}>{children}</button>
  );
}
function Badge({status}){
  const c=statusColor(status);
  return <span style={{fontSize:8,letterSpacing:"0.1em",padding:"2px 7px",color:c,border:`1px solid ${c}44`,background:statusBg(status),whiteSpace:"nowrap"}}>{status}</span>;
}
function RingChart({value,max,color,label,sub}){
  const r=30,cx=38,cy=38,circ=2*Math.PI*r,pct=Math.min(1,value/Math.max(max,1));
  return(
    <div style={{textAlign:"center",flex:1}}>
      <svg width={76} height={76} style={{display:"block",margin:"0 auto"}}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={4}/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={circ} strokeDashoffset={circ*(1-pct)} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{filter:`drop-shadow(0 0 5px ${color})`,transition:"stroke-dashoffset 1.2s"}}/>
        <text x={cx} y={cx-2} textAnchor="middle" fill="#fff" fontSize={13} fontWeight={700} fontFamily="Rajdhani,sans-serif">{value}</text>
        <text x={cx} y={cx+10} textAnchor="middle" fill={color} fontSize={7}>{sub}</text>
      </svg>
      <div style={{fontSize:8,color:"rgba(255,255,255,0.28)",marginTop:2,letterSpacing:"0.1em"}}>{label}</div>
    </div>
  );
}
function Pill({label,ok,blink=false}){
  const c=ok?C.green:C.pink;
  return(
    <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",border:`1px solid ${c}25`,background:`${c}08`}}>
      <div style={{width:4,height:4,borderRadius:"50%",background:c,boxShadow:`0 0 5px ${c}`,flexShrink:0,...(blink?{animation:"blink 1.5s ease infinite"}:{})}}/>
      <span style={{fontSize:8,letterSpacing:"0.1em",color:`${c}bb`,whiteSpace:"nowrap"}}>{label}</span>
    </div>
  );
}

// ── Countdown display ─────────────────────────────────────────
function Countdown({targetDate}){
  const [left,setLeft]=useState("");
  useEffect(()=>{
    const tick=()=>{
      const secs=Math.max(0,Math.floor((new Date(targetDate)-Date.now())/1000));
      if(secs<=0){setLeft("✓ READY");return;}
      const d=Math.floor(secs/86400),h=Math.floor((secs%86400)/3600),m=Math.floor((secs%3600)/60),s=secs%60;
      if(d>0)      setLeft(`${d}d ${h}h ${m}m ${String(s).padStart(2,"0")}s`);
      else if(h>0) setLeft(`${h}h ${m}m ${String(s).padStart(2,"0")}s`);
      else         setLeft(`${m}m ${String(s).padStart(2,"0")}s`);
    };
    tick();
    const t=setInterval(tick,1000);
    return()=>clearInterval(t);
  },[targetDate]);
  const urgent=left!=="✓ READY"&&left!=="EXPIRED"&&!left.includes("d")&&!left.includes("h");
  return <span style={{color:left==="✓ READY"?C.green:left==="EXPIRED"?C.pink:urgent?C.amber:C.cyan,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{left}</span>;
}

// ── ProxyRow ──────────────────────────────────────────────────
function ProxyRow({proxy}){
  const [hov,setHov]=useState(false);
  const pct=proxy.matured?100:Math.max(5,((100-proxy.daysLeft)/100)*100);
  const c=statusColor(proxy.status);
  const graceSecs=proxy.matured?Math.max(0,(proxy.graceExpiry-Date.now())/1000):null;
  const graceUrgent=graceSecs!==null&&graceSecs<86400*2;
  return(
    <div onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{display:"grid",gridTemplateColumns:"28px 1fr 58px 80px",gap:8,alignItems:"center",
        padding:"10px 14px",borderBottom:"1px solid rgba(0,245,255,0.04)",
        background:hov?"rgba(0,245,255,0.025)":"transparent",transition:"background 0.2s",
        outline:graceUrgent?`1px solid ${C.pink}22`:undefined}}>
      <span style={{fontSize:10,color:"rgba(255,255,255,0.2)"}}>#{String(proxy.id+1).padStart(2,"0")}</span>
      <div>
        <div style={{height:2,background:"rgba(255,255,255,0.05)",borderRadius:1,marginBottom:4}}>
          <div style={{height:"100%",width:`${pct}%`,background:`linear-gradient(90deg,${c}66,${c})`,borderRadius:1,boxShadow:`0 0 5px ${c}55`,transition:"width 0.5s"}}/>
        </div>
        <div style={{fontSize:9,color:"rgba(255,255,255,0.22)"}}>
          {proxy.matured
            ? <span>matured · grace expires <Countdown targetDate={proxy.graceExpiry}/></span>
            : `${proxy.daysLeft}d left · matures ${proxy.maturityDate}`}
        </div>
      </div>
      <Badge status={proxy.status}/>
      <div style={{textAlign:"right"}}>
        <div style={{fontSize:9,color:`${C.amber}cc`}}>
          {proxy.estimatedXen==null?"—":`~${fmtN(proxy.estimatedXen)}`}
        </div>
        <div style={{fontSize:8,color:"rgba(255,255,255,0.2)"}}>{proxy.maturityDate}</div>
      </div>
    </div>
  );
}

// ── Custom tooltip for charts ─────────────────────────────────
function ChartTip({active,payload,label}){
  if(!active||!payload?.length)return null;
  return(
    <div style={{background:"rgba(0,5,20,0.95)",border:`1px solid ${C.cyan}33`,padding:"8px 12px"}}>
      <div style={{fontSize:9,color:`${C.cyan}88`,marginBottom:4}}>{label}</div>
      {payload.map(p=>(
        <div key={p.name} style={{fontSize:11,color:p.color,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>
          {p.name}: {fmtN(p.value)}{p.name==="gas"?" PLS":""}
        </div>
      ))}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════
export default function XenDashboard(){
  const w=useWidth(), mobile=w<700;

  // Wallet
  const [account,     setAccount]    = useState(null);
  const [chainOk,     setChainOk]    = useState(false);
  const [connecting,  setConnecting] = useState(false);
  const [managerAddr, setManagerAddr]= useState("");
  const [inputAddr,   setInputAddr]  = useState("");

  // Auto-load saved contract address (or fall back to V3 default)
  useEffect(()=>{
    try{
      const saved = localStorage.getItem("xen_manager_addr");
      if(saved&&saved.startsWith("0x")&&saved.length===42){
        setManagerAddr(saved);
        setInputAddr(saved);
      } else {
        setManagerAddr(DEFAULT_MANAGER);
        setInputAddr(DEFAULT_MANAGER);
      }
    }catch{
      setManagerAddr(DEFAULT_MANAGER);
      setInputAddr(DEFAULT_MANAGER);
    }
  },[]);

  // One-click switcher: persist choice and reset cached state.
  // Plain function (not useCallback) — showToast is recreated each render.
  const switchManager = (addr)=>{
    setManagerAddr(addr);
    setInputAddr(addr);
    setCd(null);
    setProxies([]);
    setAllProxiesLoaded(false);
    try{ localStorage.setItem("xen_manager_addr",addr); }catch{}
    const known = KNOWN_CONTRACTS.find(k=>k.address.toLowerCase()===addr.toLowerCase());
    showToast(`Switched to ${known?known.label:short(addr)}`,C.cyan);
  };
  const [demoMode,    setDemoMode]   = useState(false);

  // Contract data
  const [cd,      setCd]      = useState(null);
  const [xenBal,  setXenBal]  = useState("0");      // native pXEN (0x8a7F...)
  const [forkXenBal, setForkXenBal] = useState("0"); // fork XEN (0x06450dEe...)
  const [plsBal,  setPlsBal]  = useState("0");
  const [proxies, setProxies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingProxies, setLoadingProxies] = useState(false);
  const [allProxiesLoaded, setAllProxiesLoaded] = useState(false);

  // Analytics
  const [analytics, setAnalytics] = useState({ totalEarned:0, totalGasPls:0, claimCount:0, chartData:[] });

  // P&L prices (from PulseX)
  const [prices, setPrices] = useState({ pls:0, xen:0, pxen:0, loaded:false });

  // Auto-claim settings
  const [checkMins,    setCheckMins]    = useState(10);
  const [restakePct,   setRestakePct]   = useState(50);
  const [mintTermDays, setMintTermDays] = useState(100);
  const [autoRestart,  setAutoRestart]  = useState(true);

  // Auto-claim state
  const [autoOn,       setAutoOn]      = useState(false);
  const [lastCheck,    setLastCheck]   = useState(null);
  const [failCount,    setFailCount]   = useState(0);
  const [lastError,    setLastError]   = useState(null);
  const [notifPerms,   setNotifPerms]  = useState(typeof Notification!=="undefined"?Notification.permission:"unsupported");
  const intervalRef = useRef(null);

  // UI
  const [tab,          setTab]         = useState("overview");
  const [filter,       setFilter]      = useState("ALL");
  const [toast,        setToast]       = useState(null);
  const [time,         setTime]        = useState(new Date());
  const [txPending,    setTxPending]   = useState(null);
  const [claimHistory, setClaimHistory]= useState([]);

  // XENFT state (OG)
  const [xenfts,       setXenfts]     = useState([]);
  const [xenftLoading, setXenftLoading]=useState(false);
  const [xenftModal,   setXenftModal] = useState(false);
  const [nftCount,     setNftCount]   = useState(3);
  const [nftVmus,      setNftVmus]    = useState(100);
  const [nftTerm,      setNftTerm]    = useState(100);
  const [nftMinting,   setNftMinting] = useState(false);
  const [nftProgress,  setNftProgress]= useState(0);

  // Native XENFT state
  const [nativeXenfts,       setNativeXenfts]    = useState([]);
  const [nativeLoading,      setNativeLoading]   = useState(false);
  const [nativeModal,        setNativeModal]     = useState(false);
  const [nativeCount,        setNativeCount]     = useState(3);
  const [nativeVmus,         setNativeVmus]      = useState(100);
  const [nativeTerm,         setNativeTerm]      = useState(100);
  const [nativeMinting,      setNativeMinting]   = useState(false);
  const [nativeProgress,     setNativeProgress]  = useState(0);
  const [nativeXenBal,       setNativeXenBal]    = useState("0");

  // Transaction logs for XENFT tab
  const [xenftLogs, setXenftLogs] = useState([]);
  const addLog=(msg,type="info",hash=null)=>{
    const entry={
      id:Date.now()+Math.random(),
      time:new Date().toLocaleTimeString(),
      msg,type,hash
    };
    setXenftLogs(l=>[entry,...l].slice(0,50));
  };

  // Mint modal
  const [mintModal,    setMintModal]   = useState(false);
  const [mintCount,    setMintCount]   = useState(50);
  const [mintTerm,     setMintTerm]    = useState(100);
  const [minting,      setMinting]     = useState(false);
  const [mintGasUsed,  setMintGasUsed] = useState(null);
  const [gasBreakdown, setGasBreakdown]= useState(null);
  const [liveGasPrice, setLiveGasPrice]= useState(null); // wei per gas unit

  // Fetch live gas price when modal opens
  const fetchGasPrice=useCallback(async()=>{
    try{
      const r=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_gasPrice",params:[]})});
      const j=await r.json();
      setLiveGasPrice(BigInt(j.result||"0"));
    }catch{}
  },[]);

  useEffect(()=>{if(mintModal)fetchGasPrice();},[mintModal]);

  useEffect(()=>{const t=setInterval(()=>setTime(new Date()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>()=>{if(intervalRef.current)clearInterval(intervalRef.current);},[]);

  const showToast=(msg,color=C.green)=>{setToast({msg,color});setTimeout(()=>setToast(null),4000);};

  // ── Browser notifications ────────────────────────────────────
  const requestNotifs=async()=>{
    if(typeof Notification==="undefined"){showToast("Notifications not supported here",C.amber);return;}
    const perm=await Notification.requestPermission();
    setNotifPerms(perm);
    if(perm==="granted")showToast("✓ Notifications enabled",C.green);
    else showToast("Notifications blocked — enable in browser settings",C.amber);
  };
  const pushNotif=(title,body)=>{
    if(typeof Notification!=="undefined"&&Notification.permission==="granted"){
      try{ new Notification(title,{body}); }catch{}
    }
  };

  // ── Demo mode ────────────────────────────────────────────────
  const enterDemo=()=>{
    setDemoMode(true);setCd(DEMO_CD);setXenBal("170000");setForkXenBal("2847392");setPlsBal("1842.33");
    setProxies(DEMO_PROXIES);setAllProxiesLoaded(true);
    setAnalytics(DEMO_ANALYTICS);setLastCheck(new Date());
    setXenfts(DEMO_XENFTS);setMintGasUsed("12.4821");
  };
  const exitDemo=()=>{
    setDemoMode(false);setCd(null);setXenBal("0");setForkXenBal("0");setPlsBal("0");
    setProxies([]);setAllProxiesLoaded(false);
    setAnalytics({totalEarned:0,totalGasPls:0,claimCount:0,chartData:[]});
    setXenfts([]);
  };

  // ── Load owned XENFTs via Transfer events + ownership check ─
  const loadXENFTs=useCallback(async()=>{
    if(!account)return;
    setXenftLoading(true);
    addLog(`Loading XENFTs for ${short(account)}...`,"info");
    try{
      // Check actual balance on-chain first
      const balH=await ethCall(XENFT_ADDRESS,"balanceOf(address)",[account]);
      const bal=decodeUint(balH);
      addLog(`On-chain balance: ${bal} XENFTs`,"info");
      if(bal===0){
        setXenfts([]);
        setXenftLoading(false);
        return;
      }

      // Get current block
      const blockRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_blockNumber",params:[]})});
      const blockJson=await blockRes.json();
      const currentBlock=parseInt(blockJson.result,16);
      addLog(`Scanning blocks up to ${currentBlock}`,"info");

      // Find owned token IDs via Transfer events (chunked to avoid RPC limits)
      const transferTopic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const paddedAccount="0x000000000000000000000000"+account.slice(2).toLowerCase();
      const ownedIds=new Set();

      // PulseChain supports wider ranges but chunk just in case
      const CHUNK=500000;
      let fromBlock=0;
      while(fromBlock<currentBlock){
        const toBlock=Math.min(fromBlock+CHUNK,currentBlock);
        try{
          const logsRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getLogs",params:[{
              address:XENFT_ADDRESS,
              fromBlock:"0x"+fromBlock.toString(16),
              toBlock:"0x"+toBlock.toString(16),
              topics:[transferTopic, null, paddedAccount]
            }]})});
          const logsJson=await logsRes.json();
          if(logsJson.error){
            addLog(`Log query error (${fromBlock}-${toBlock}): ${logsJson.error.message}`,"warning");
          }else if(logsJson.result){
            for(const log of logsJson.result){
              const tokenId=BigInt(log.topics[3]).toString();
              ownedIds.add(tokenId);
            }
          }
        }catch(err){
          addLog(`RPC error: ${err.message}`,"error");
        }
        fromBlock=toBlock+1;
      }

      addLog(`Found ${ownedIds.size} transfer events`,"info");

      // Verify each is still owned and read data SEQUENTIALLY to avoid rate limits
      const tokens=[];
      let skipped=0;
      const idsArray=[...ownedIds];
      for(let idx=0; idx<idsArray.length; idx++){
        const tokenId=idsArray[idx];
        try{
          const ownerH=await ethCall(XENFT_ADDRESS,"ownerOf(uint256)",[tokenId]);
          const owner=decodeAddr(ownerH);
          if(!owner||owner.toLowerCase()!==account.toLowerCase()){
            skipped++;
            continue;
          }
        }catch(e){
          addLog(`#${tokenId}: ownerOf failed — ${e.message}`,"warning");
          skipped++;
          continue;
        }

        // Read VMU count and mint info with retry
        let vmus="?", term="?", maturityTs=0, daysLeft=0, matured=false, maturityDate="—", redeemed=false;

        // vmuCount with retry
        for(let attempt=0; attempt<3; attempt++){
          try{
            const vmuRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:XENFT_ADDRESS,data:"0xa1a53fa1"+BigInt(tokenId).toString(16).padStart(64,"0")},"latest"]})});
            const vmuJson=await vmuRes.json();
            if(vmuJson.result&&vmuJson.result!=="0x"&&vmuJson.result.length>=66){
              vmus=decodeUint(vmuJson.result);
              break;
            }
          }catch{}
          if(attempt<2)await new Promise(r=>setTimeout(r,200));
        }

        // mintInfo with retry
        for(let attempt=0; attempt<3; attempt++){
          try{
            const mintRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({jsonrpc:"2.0",id:2,method:"eth_call",params:[{to:XENFT_ADDRESS,data:"0x443aa533"+BigInt(tokenId).toString(16).padStart(64,"0")},"latest"]})});
            const mintJson=await mintRes.json();
            if(mintJson.result&&mintJson.result!=="0x"&&mintJson.result.length>=66){
              const info=BigInt(mintJson.result);
              const termBits=Number((info>>240n)&0xFFFFn);
              const mintTsBits=Number((info>>176n)&0xFFFFFFFFn);
              term=termBits;
              maturityTs=mintTsBits+termBits*86400;
              const now=Math.floor(Date.now()/1000);
              daysLeft=Math.ceil((maturityTs-now)/86400);
              // OG XENFT mintInfo's low byte is the redeemed flag.
              // "matured" repurposed to mean "claimable" — matches xen.network
              // behavior of showing Claim XEN for any unredeemed token.
              redeemed=(info & 0xFFn) === 1n;
              matured=!redeemed;
              maturityDate=maturityTs>0?new Date(maturityTs*1000).toLocaleDateString():"—";
              break;
            }
          }catch{}
          if(attempt<2)await new Promise(r=>setTimeout(r,200));
        }

        // Debug log for first 3 tokens
        if(idx<3) addLog(`#${tokenId}: vmus=${vmus} term=${term} maturity=${maturityTs} redeemed=${redeemed}`,"info");

        // Ghost filter
        if(maturityTs===0){skipped++;continue;}
        if(vmus==="?"||vmus===0){skipped++;continue;}
        if(term==="?"||term===0){skipped++;continue;}
        if(maturityTs < 1640000000){skipped++;continue;}
        if(maturityTs > 2000000000){skipped++;continue;}

        tokens.push({
          tokenId:String(tokenId),vmus,term,
          daysLeft:Math.max(0,daysLeft),matured,redeemed,maturityDate,maturityTs,
          graceExpiry:new Date((maturityTs+7*86400)*1000),
          // Real XEN reward depends on cRank, AMP, EAA and a log function.
          // Refusing to invent a number. Source of truth: og.xen.network.
          estXen:null,
        });

        // Small delay between tokens to avoid rate limits
        if(idx<idsArray.length-1) await new Promise(r=>setTimeout(r,50));
      }

      // Sort by tokenId descending (newest first)
      tokens.sort((a,b)=>Number(BigInt(b.tokenId)-BigInt(a.tokenId)));
      setXenfts(tokens);
      addLog(`✓ Loaded ${tokens.length} valid XENFTs (${skipped} filtered)`,"success");
      if(tokens.length>0) showToast(`✓ ${tokens.length} XENT verified`,C.purple);
      else showToast(`No valid XENFTs found (${skipped} filtered, balance: ${bal})`,C.amber);
    }catch(e){
      addLog(`Load error: ${e.message}`,"error");
      showToast("XENFT load error: "+e.message,C.pink);
    }
    finally{setXenftLoading(false);}
  },[account]);

  useEffect(()=>{if(account&&(managerAddr||demoMode))loadXENFTs();},[account]);

  // ── Mint multiple XENFTs ─────────────────────────────────────
  const handleMintXENFTs=async()=>{
    if(!account){showToast("Connect wallet first",C.pink);return;}
    if(!window.ethereum){showToast("MetaMask not found",C.pink);return;}
    setNftMinting(true);setNftProgress(0);
    addLog(`Starting mint: ${nftCount} XENFTs × ${nftVmus} VMUs × ${nftTerm}d`,"info");

    // Pre-flight simulation — don't waste gas on reverts
    addLog(`Pre-flight check...`,"pending");
    try{
      const data="0x"+sel("bulkClaimRank(uint256,uint256)")+pad32(nftVmus)+pad32(nftTerm);
      const simRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{
          from:account,to:XENFT_ADDRESS,data
        },"latest"]})});
      const simJson=await simRes.json();
      if(simJson.error){
        const msg=simJson.error.message||"reverts";
        addLog(`✗ Would revert: ${msg}`,"error");
        showToast(`❌ Would revert: ${msg}. Try a lower term.`,C.pink);
        setNftMinting(false);
        setTxPending(null);
        return;
      }
      addLog(`✓ Pre-flight passed`,"success");
    }catch(e){
      addLog(`Pre-flight failed: ${e.message}`,"warning");
    }

    let successCount=0;
    for(let i=0;i<nftCount;i++){
      try{
        const data="0x"+sel("bulkClaimRank(uint256,uint256)")+pad32(nftVmus)+pad32(nftTerm);
        const gasNeeded = Math.min(30_000_000, 300_000 + nftVmus * 500_000);
        const gasHex = "0x" + gasNeeded.toString(16);
        setTxPending(`Minting XENFT ${i+1} of ${nftCount} (${nftVmus} VMUs)`);
        addLog(`Waiting for approval ${i+1}/${nftCount}...`,"pending");
        showToast(`⏳ Approve XENFT ${i+1}/${nftCount} in your wallet`,C.cyan);
        const hash=await window.ethereum.request({
          method:"eth_sendTransaction",
          params:[{from:account, to:XENFT_ADDRESS, data, gas:gasHex}],
        });
        successCount++;
        setNftProgress(i+1);
        addLog(`XENFT ${i+1}/${nftCount} submitted`,"success",hash);
        showToast(`✓ XENFT ${i+1}/${nftCount} submitted — ${short(hash)}`,C.green);

        // Poll for confirmation
        addLog(`Waiting for confirmation...`,"pending");
        const receipt = await waitForReceipt(hash);
        if(receipt){
          if(receipt.status==="0x1"){
            addLog(`✓ XENFT ${i+1} confirmed in block ${parseInt(receipt.blockNumber,16)} — gas used: ${parseInt(receipt.gasUsed,16).toLocaleString()}`,"success",hash);
          }else{
            addLog(`✗ XENFT ${i+1} REVERTED — check tx on PulseScan`,"error",hash);
          }
        }
        await new Promise(r=>setTimeout(r,2000));
      }catch(e){
        setTxPending(null);
        if(e.code===4001){
          addLog("Transaction cancelled by user","warning");
          showToast("Transaction cancelled",C.amber);
          break;
        }
        addLog(`XENFT ${i+1} failed: ${e.message||"unknown error"}`,"error");
        showToast(`XENFT ${i+1} failed: ${e.message||"unknown error"}`,C.pink);
        console.error("XENFT mint error:",e);
        break;
      }
    }
    setTxPending(null);
    setNftMinting(false);
    if(successCount>0){
      addLog(`Mint session complete: ${successCount}/${nftCount} successful`,"success");
      showToast(`✓ ${successCount} XENFT${successCount>1?"s":""} minted! Refreshing...`,C.green);
      setXenftModal(false);
      setTimeout(()=>loadXENFTs(),8000);
    }
  };

  // Poll for tx receipt
  const waitForReceipt=async(hash,maxAttempts=30)=>{
    for(let i=0;i<maxAttempts;i++){
      try{
        const r=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getTransactionReceipt",params:[hash]})});
        const j=await r.json();
        if(j.result) return j.result;
      }catch{}
      await new Promise(r=>setTimeout(r,2000));
    }
    return null;
  };

  // ── Claim XENFT rewards ──────────────────────────────────────
  const handleClaimXENFT=async(tokenId)=>{
    let data="0x"+sel("bulkClaimMintReward(uint256,address)")+pad32(tokenId)+pad32(account);
    setTxPending(`Claiming XENFT #${tokenId}`);
    addLog(`Claiming XENFT #${tokenId}...`,"pending");
    try{
      const hash=await window.ethereum.request({method:"eth_sendTransaction",
        params:[{from:account,to:XENFT_ADDRESS,data,gas:"0x7A1200"}]});
      addLog(`Claim tx sent for #${tokenId}`,"success",hash);
      showToast(`✓ XENFT #${tokenId} claim submitted — ${short(hash)}`,C.green);

      const receipt = await waitForReceipt(hash);
      if(receipt){
        if(receipt.status==="0x1"){
          addLog(`✓ XENFT #${tokenId} claimed! Block ${parseInt(receipt.blockNumber,16)}`,"success",hash);
        }else{
          addLog(`✗ Claim REVERTED for #${tokenId}`,"error",hash);
        }
      }
      setTimeout(()=>{loadXENFTs();loadData();setTxPending(null);},6000);
    }catch(e){
      setTxPending(null);
      if(e.code!==4001){
        addLog(`Claim failed for #${tokenId}: ${e.message}`,"error");
        showToast(`Claim failed: ${e.message}`,C.pink);
      }else{
        addLog(`Claim cancelled for #${tokenId}`,"warning");
      }
    }
  };

  // ── pXENT: Load balance + XENFTs ─────────────────────────────
  const loadNativeData=useCallback(async()=>{
    if(!account)return;
    setNativeLoading(true);
    addLog(`[pXENT] Loading for ${short(account)}...`,"info");
    try{
      const balH=await ethCall(NATIVE_XEN,"balanceOf(address)",[account]);
      setNativeXenBal((Number(BigInt(balH||"0"))/1e18).toFixed(0));

      const nftBalH=await ethCall(NATIVE_XENFT,"balanceOf(address)",[account]);
      const nftBal=decodeUint(nftBalH);
      addLog(`[pXENT] On-chain balance: ${nftBal}`,"info");

      if(nftBal===0){
        setNativeXenfts([]);
        setNativeLoading(false);
        return;
      }

      const blockRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_blockNumber",params:[]})});
      const blockJson=await blockRes.json();
      const currentBlock=parseInt(blockJson.result,16);
      addLog(`[pXENT] Scanning blocks up to ${currentBlock}`,"info");

      const transferTopic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const paddedAccount="0x000000000000000000000000"+account.slice(2).toLowerCase();
      const ownedIds=new Set();

      const CHUNK=500000;
      let fromBlock=0;
      while(fromBlock<currentBlock){
        const toBlock=Math.min(fromBlock+CHUNK,currentBlock);
        try{
          const logsRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getLogs",params:[{
              address:NATIVE_XENFT,
              fromBlock:"0x"+fromBlock.toString(16),
              toBlock:"0x"+toBlock.toString(16),
              topics:[transferTopic, null, paddedAccount]
            }]})});
          const logsJson=await logsRes.json();
          if(logsJson.error){
            addLog(`[pXENT] Log error (${fromBlock}-${toBlock}): ${logsJson.error.message}`,"warning");
          }else if(logsJson.result){
            for(const log of logsJson.result){
              ownedIds.add(BigInt(log.topics[3]).toString());
            }
          }
        }catch(err){
          addLog(`[pXENT] RPC error: ${err.message}`,"error");
        }
        fromBlock=toBlock+1;
      }

      addLog(`[pXENT] Found ${ownedIds.size} transfer events`,"info");

      const tokens=[];
      let skipped=0;
      const idsArray=[...ownedIds];
      for(let idx=0; idx<idsArray.length; idx++){
        const tokenId=idsArray[idx];
        try{
          const ownerH=await ethCall(NATIVE_XENFT,"ownerOf(uint256)",[tokenId]);
          const owner=decodeAddr(ownerH);
          if(!owner||owner.toLowerCase()!==account.toLowerCase()){
            skipped++;
            continue;
          }
        }catch{skipped++;continue;}

        let vmus="?", term="?", maturityTs=0, daysLeft=0, matured=false, maturityDate="—", redeemed=false;
        for(let attempt=0; attempt<3; attempt++){
          try{
            const vmuRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:NATIVE_XENFT,data:"0xa1a53fa1"+BigInt(tokenId).toString(16).padStart(64,"0")},"latest"]})});
            const vmuJson=await vmuRes.json();
            if(vmuJson.result&&vmuJson.result!=="0x"&&vmuJson.result.length>=66){
              vmus=decodeUint(vmuJson.result);
              break;
            }
          }catch{}
          if(attempt<2)await new Promise(r=>setTimeout(r,200));
        }

        for(let attempt=0; attempt<3; attempt++){
          try{
            const mintRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({jsonrpc:"2.0",id:2,method:"eth_call",params:[{to:NATIVE_XENFT,data:"0x443aa533"+BigInt(tokenId).toString(16).padStart(64,"0")},"latest"]})});
            const mintJson=await mintRes.json();
            if(mintJson.result&&mintJson.result!=="0x"&&mintJson.result.length>=66){
              const info=BigInt(mintJson.result);
              const termBits=Number((info>>240n)&0xFFFFn);
              const mintTsBits=Number((info>>176n)&0xFFFFFFFFn);
              term=termBits;
              maturityTs=mintTsBits+termBits*86400;
              const now=Math.floor(Date.now()/1000);
              daysLeft=Math.ceil((maturityTs-now)/86400);
              redeemed=(info & 0xFFn) === 1n;
              // Same xen.network parity: claimable = unredeemed.
              matured=!redeemed;
              maturityDate=maturityTs>0?new Date(maturityTs*1000).toLocaleDateString():"—";
              break;
            }
          }catch{}
          if(attempt<2)await new Promise(r=>setTimeout(r,200));
        }

        if(idx<3) addLog(`[pXENT] #${tokenId}: vmus=${vmus} term=${term} maturity=${maturityTs} redeemed=${redeemed}`,"info");

        if(maturityTs===0){skipped++;continue;}
        if(vmus==="?"||vmus===0){skipped++;continue;}
        if(term==="?"||term===0){skipped++;continue;}
        if(maturityTs < 1640000000){skipped++;continue;}
        if(maturityTs > 2000000000){skipped++;continue;}

        tokens.push({
          tokenId:String(tokenId), vmus, term,
          daysLeft:Math.max(0,daysLeft), matured, redeemed, maturityDate, maturityTs,
          graceExpiry:new Date((maturityTs+7*86400)*1000),
          estXen:null, // see comment in OG XENT loader
        });

        if(idx<idsArray.length-1) await new Promise(r=>setTimeout(r,50));
      }

      tokens.sort((a,b)=>Number(BigInt(b.tokenId)-BigInt(a.tokenId)));
      setNativeXenfts(tokens);
      addLog(`[pXENT] ✓ Loaded ${tokens.length} valid pXENTs (${skipped} filtered)`,"success");
      if(tokens.length>0) showToast(`✓ ${tokens.length} pXENTs verified`,C.pink);
      else showToast(`No valid pXENTs (${skipped} filtered, balance: ${nftBal})`,C.amber);
    }catch(e){
      addLog(`[pXENT] Load error: ${e.message}`,"error");
      showToast("Load error: "+e.message,C.pink);
    }
    finally{setNativeLoading(false);}
  },[account]);

  useEffect(()=>{if(account)loadNativeData();},[account]);

  // ── Mint Native XENFTs ───────────────────────────────────────
  const handleMintNative=async()=>{
    if(!account){showToast("Connect wallet first",C.pink);return;}
    setNativeMinting(true);setNativeProgress(0);
    addLog(`[Native] Starting: ${nativeCount} pXENTs × ${nativeVmus} VMUs × ${nativeTerm}d`,"info");

    // Pre-flight simulation — check if this config will revert
    addLog(`[Native] Pre-flight check...`,"pending");
    try{
      const data="0x"+sel("bulkClaimRank(uint256,uint256)")+pad32(nativeVmus)+pad32(nativeTerm);
      const simRes=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{
          from:account,to:NATIVE_XENFT,data
        },"latest"]})});
      const simJson=await simRes.json();
      if(simJson.error){
        const msg=simJson.error.message||"reverts";
        addLog(`[Native] ✗ Would revert: ${msg}`,"error");
        showToast(`❌ Would revert: ${msg}. Try a lower term (max ~533 days)`,C.pink);
        setNativeMinting(false);
        setTxPending(null);
        return;
      }
      addLog(`[Native] ✓ Pre-flight passed, proceeding`,"success");
    }catch(e){
      addLog(`[Native] Pre-flight failed: ${e.message}`,"warning");
      // Continue anyway since simulation itself errored
    }

    let success=0;
    for(let i=0;i<nativeCount;i++){
      try{
        const data="0x"+sel("bulkClaimRank(uint256,uint256)")+pad32(nativeVmus)+pad32(nativeTerm);
        const gasNeeded=Math.min(30_000_000, 300_000 + nativeVmus*500_000);
        setTxPending(`Minting Native XENFT ${i+1}/${nativeCount}`);
        addLog(`[Native] Waiting approval ${i+1}/${nativeCount}...`,"pending");
        showToast(`⏳ Approve Native XENFT ${i+1}/${nativeCount} in your wallet`,C.cyan);
        const hash=await window.ethereum.request({
          method:"eth_sendTransaction",
          params:[{from:account,to:NATIVE_XENFT,data,gas:"0x"+gasNeeded.toString(16)}],
        });
        success++;
        setNativeProgress(i+1);
        addLog(`[Native] pXENT ${i+1}/${nativeCount} submitted`,"success",hash);
        showToast(`✓ Native XENFT ${i+1}/${nativeCount} submitted — ${short(hash)}`,C.green);

        addLog(`[Native] Waiting for confirmation...`,"pending");
        const receipt = await waitForReceipt(hash);
        if(receipt){
          if(receipt.status==="0x1"){
            addLog(`[Native] ✓ pXENT ${i+1} confirmed in block ${parseInt(receipt.blockNumber,16)} — gas: ${parseInt(receipt.gasUsed,16).toLocaleString()}`,"success",hash);
          }else{
            addLog(`[Native] ✗ pXENT ${i+1} REVERTED`,"error",hash);
          }
        }
        await new Promise(r=>setTimeout(r,2000));
      }catch(e){
        setTxPending(null);
        if(e.code===4001){
          addLog("[Native] Cancelled by user","warning");
          showToast("Cancelled",C.amber);
          break;
        }
        addLog(`[Native] pXENT ${i+1} failed: ${e.message||"error"}`,"error");
        showToast(`Native XENFT ${i+1} failed: ${e.message||"error"}`,C.pink);
        break;
      }
    }
    setTxPending(null);setNativeMinting(false);
    if(success>0){
      addLog(`[Native] Session complete: ${success}/${nativeCount} successful`,"success");
      showToast(`✓ ${success} Native XENFT${success>1?"s":""} minted!`,C.green);
      setNativeModal(false);
      setTimeout(()=>loadNativeData(),8000);
    }
  };

  const handleClaimNative=async(tokenId)=>{
    const data="0x"+sel("bulkClaimMintReward(uint256,address)")+pad32(tokenId)+pad32(account);
    setTxPending(`Claiming Native XENFT #${tokenId}`);
    addLog(`[Native] Claiming pXENT #${tokenId}...`,"pending");
    try{
      const hash=await window.ethereum.request({method:"eth_sendTransaction",
        params:[{from:account,to:NATIVE_XENFT,data,gas:"0x7A1200"}]});
      addLog(`[Native] Claim tx sent for pXENT #${tokenId}`,"success",hash);
      showToast(`✓ Native XENFT #${tokenId} claim submitted — ${short(hash)}`,C.green);

      const receipt = await waitForReceipt(hash);
      if(receipt){
        if(receipt.status==="0x1"){
          addLog(`[Native] ✓ pXENT #${tokenId} claimed!`,"success",hash);
        }else{
          addLog(`[Native] ✗ Claim REVERTED for pXENT #${tokenId}`,"error",hash);
        }
      }
      setTimeout(()=>{loadNativeData();setTxPending(null);},6000);
    }catch(e){
      setTxPending(null);
      if(e.code!==4001){
        addLog(`[Native] Claim failed: ${e.message}`,"error");
        showToast(`Claim failed: ${e.message}`,C.pink);
      }
    }
  };

  // ── Claim ALL matured XENTs ──────────────────────────────────
  const handleClaimAllXents=async()=>{
    if(!account){showToast("Connect wallet",C.pink);return;}
    const matured=xenfts.filter(x=>x.matured);
    if(matured.length===0){showToast("No matured XENTs",C.amber);return;}
    if(!window.confirm(`Claim ALL ${matured.length} matured XENTs?\n\nYou'll approve ${matured.length} transactions in sequence.`))return;

    addLog(`[XENT] CLAIM ALL: ${matured.length} tokens`,"info");
    let success=0, failed=0;
    for(let i=0;i<matured.length;i++){
      const nft=matured[i];
      try{
        const data="0x"+sel("bulkClaimMintReward(uint256,address)")+pad32(nft.tokenId)+pad32(account);
        setTxPending(`Claim All XENT: ${i+1}/${matured.length} (#${nft.tokenId})`);
        addLog(`[XENT] Claiming #${nft.tokenId} (${i+1}/${matured.length})...`,"pending");
        const hash=await window.ethereum.request({method:"eth_sendTransaction",
          params:[{from:account,to:XENFT_ADDRESS,data,gas:"0x7A1200"}]});
        addLog(`[XENT] #${nft.tokenId} submitted`,"success",hash);

        const receipt=await waitForReceipt(hash);
        if(receipt&&receipt.status==="0x1"){
          success++;
          addLog(`[XENT] ✓ #${nft.tokenId} claimed (block ${parseInt(receipt.blockNumber,16)})`,"success",hash);
        }else{
          failed++;
          addLog(`[XENT] ✗ #${nft.tokenId} REVERTED`,"error",hash);
        }
        await new Promise(r=>setTimeout(r,1500));
      }catch(e){
        if(e.code===4001){
          addLog("[XENT] User cancelled — stopping batch","warning");
          break;
        }
        failed++;
        addLog(`[XENT] #${nft.tokenId} failed: ${e.message||"error"}`,"error");
      }
    }
    setTxPending(null);
    addLog(`[XENT] BATCH COMPLETE: ${success} success, ${failed} failed`,success>0?"success":"error");
    showToast(`✓ Claimed ${success}/${matured.length} XENTs`,success===matured.length?C.green:C.amber);
    setTimeout(()=>loadXENFTs(),5000);
  };

  // ── Claim ALL matured pXENTs ─────────────────────────────────
  const handleClaimAllPxents=async()=>{
    if(!account){showToast("Connect wallet",C.pink);return;}
    const matured=nativeXenfts.filter(x=>x.matured);
    if(matured.length===0){showToast("No matured pXENTs",C.amber);return;}
    if(!window.confirm(`Claim ALL ${matured.length} matured pXENTs?\n\nYou'll approve ${matured.length} transactions in sequence.`))return;

    addLog(`[pXENT] CLAIM ALL: ${matured.length} tokens`,"info");
    let success=0, failed=0;
    for(let i=0;i<matured.length;i++){
      const nft=matured[i];
      try{
        const data="0x"+sel("bulkClaimMintReward(uint256,address)")+pad32(nft.tokenId)+pad32(account);
        setTxPending(`Claim All pXENT: ${i+1}/${matured.length} (#${nft.tokenId})`);
        addLog(`[pXENT] Claiming #${nft.tokenId} (${i+1}/${matured.length})...`,"pending");
        const hash=await window.ethereum.request({method:"eth_sendTransaction",
          params:[{from:account,to:NATIVE_XENFT,data,gas:"0x7A1200"}]});
        addLog(`[pXENT] #${nft.tokenId} submitted`,"success",hash);

        const receipt=await waitForReceipt(hash);
        if(receipt&&receipt.status==="0x1"){
          success++;
          addLog(`[pXENT] ✓ #${nft.tokenId} claimed`,"success",hash);
        }else{
          failed++;
          addLog(`[pXENT] ✗ #${nft.tokenId} REVERTED`,"error",hash);
        }
        await new Promise(r=>setTimeout(r,1500));
      }catch(e){
        if(e.code===4001){
          addLog("[pXENT] User cancelled","warning");
          break;
        }
        failed++;
        addLog(`[pXENT] #${nft.tokenId} failed: ${e.message||"error"}`,"error");
      }
    }
    setTxPending(null);
    addLog(`[pXENT] BATCH COMPLETE: ${success} success, ${failed} failed`,success>0?"success":"error");
    showToast(`✓ Claimed ${success}/${matured.length} pXENTs`,success===matured.length?C.green:C.amber);
    setTimeout(()=>loadNativeData(),5000);
  };

  // ── Wallet ───────────────────────────────────────────────────
  const connectWallet=async()=>{
    if(!window.ethereum){showToast("MetaMask not found",C.pink);return;}
    setConnecting(true);
    try{
      const accs=await window.ethereum.request({method:"eth_requestAccounts"});
      setAccount(accs[0]);
      const cid=await window.ethereum.request({method:"eth_chainId"});
      if(cid!==CHAIN_HEX){
        try{await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:CHAIN_HEX}]});setChainOk(true);}
        catch(e){if(e.code===4902){await window.ethereum.request({method:"wallet_addEthereumChain",params:[PULSE_NETWORK]});setChainOk(true);}else showToast("Switch to PulseChain",C.pink);}
      }else setChainOk(true);
      showToast("✓ Connected to PulseChain");
    }catch{showToast("Cancelled",C.amber);}
    finally{setConnecting(false);}
  };
  useEffect(()=>{
    if(!window.ethereum)return;
    const onA=a=>setAccount(a[0]||null);
    const onC=id=>setChainOk(id===CHAIN_HEX);
    window.ethereum.on("accountsChanged",onA);
    window.ethereum.on("chainChanged",onC);
    return()=>{window.ethereum.removeListener("accountsChanged",onA);window.ethereum.removeListener("chainChanged",onC);};
  },[]);

  // ── Load contract data ───────────────────────────────────────
  // ── Fetch live token prices from PulseX ──────────────────────
  const loadPrices=useCallback(async()=>{
    const ROUTER="0x165C3410fC91EF562C50559f7d2289fEbed552d9";
    const WPLS="0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
    const DAI="0xefD766cCb38EaF1dfd701853BFCe31359239F305";

    // Encode getAmountsOut(uint256 amountIn, address[] path)
    const encodeGetAmountsOut=(amountIn, pathArr)=>{
      const amount=amountIn.toString(16).padStart(64,"0");
      const offset="0000000000000000000000000000000000000000000000000000000000000040"; // offset=64 (0x40)
      const length=pathArr.length.toString(16).padStart(64,"0");
      const addrs=pathArr.map(a=>a.slice(2).toLowerCase().padStart(64,"0")).join("");
      return "0xd06ca61f"+amount+offset+length+addrs;
    };

    // Decode uint256[] from eth_call result
    const decodeAmountsOut=(resultHex)=>{
      if(!resultHex||resultHex==="0x")return [];
      const hex=resultHex.slice(2);
      // [offset(64), length(64), amt0(64), amt1(64), ...]
      const length=parseInt(hex.slice(64,128),16);
      const amounts=[];
      for(let i=0;i<length;i++){
        amounts.push(BigInt("0x"+hex.slice(128+i*64, 128+(i+1)*64)));
      }
      return amounts;
    };

    const callRouter=async(amountIn, path)=>{
      const data=encodeGetAmountsOut(amountIn, path);
      const res=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:ROUTER,data},"latest"]})});
      const json=await res.json();
      if(json.error)return [];
      return decodeAmountsOut(json.result);
    };

    try{
      // PLS price in USD: 1 PLS → DAI
      const plsOneEth=10n**18n;
      const plsToDai=await callRouter(plsOneEth, [WPLS, DAI]);
      const plsPrice = plsToDai.length>=2 ? Number(plsToDai[1])/1e18 : 0;

      // pXEN price: 1M pXEN → PLS → DAI (use 1M because pXEN is very cheap)
      const millionTokens=10n**24n; // 1M × 10^18
      const pxenToPls=await callRouter(millionTokens, [XEN_ADDRESS, WPLS]);
      const pxenPlsPerToken = pxenToPls.length>=2 ? (Number(pxenToPls[1])/1e18)/1_000_000 : 0;
      const pxenPrice = pxenPlsPerToken * plsPrice;

      // fork XEN price (same path)
      const xenToPls=await callRouter(millionTokens, [NATIVE_XEN, WPLS]);
      const xenPlsPerToken = xenToPls.length>=2 ? (Number(xenToPls[1])/1e18)/1_000_000 : 0;
      const xenPrice = xenPlsPerToken * plsPrice;

      console.log("Prices loaded:", {pls:plsPrice, xen:xenPrice, pxen:pxenPrice});
      setPrices({pls:plsPrice, xen:xenPrice, pxen:pxenPrice, loaded:true});
    }catch(e){
      console.warn("Price fetch error:",e);
      setPrices({pls:0,xen:0,pxen:0,loaded:false});
    }
  },[]);

  useEffect(()=>{if(account)loadPrices();},[account,loadPrices]);

  const loadData=useCallback(async()=>{
    if(!managerAddr||!account)return;
    setLoading(true);
    try{
      const [totalH,matH,soonH,ownerH,xenH,forkH]=await Promise.all([
        ethCall(managerAddr,"proxyCount()"),
        ethCall(managerAddr,"maturedCount()"),
        ethCall(managerAddr,"maturingSoon(uint256)",[3]),
        ethCall(managerAddr,"owner()"),
        ethCall(XEN_ADDRESS,"balanceOf(address)",[account]),
        ethCall(NATIVE_XEN,"balanceOf(address)",[account]),
      ]);
      const plsR=await fetch(PULSE_RPC,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getBalance",params:[account,"latest"]})});
      const plsJ=await plsR.json();
      setCd({totalProxies:decodeUint(totalH),maturedCount:decodeUint(matH),maturingSoon:decodeUint(soonH),owner:decodeAddr(ownerH)});
      setXenBal((Number(BigInt(xenH||"0"))/1e18).toFixed(0));
      setForkXenBal((Number(BigInt(forkH||"0"))/1e18).toFixed(0));
      setPlsBal((Number(BigInt(plsJ.result||"0"))/1e18).toFixed(4));

      // ── Fetch gas spent on all XEN-related transactions ─────
      try{
        // Aggregate gas across the connected owner wallet and the relayer.
        const walletsToScan=[
          account.toLowerCase(),
          RELAYER_WALLET.toLowerCase(),
        ];
        // All known managers (V2 + V3 + future). Stable across UI contract switches.
        const knownManagers = new Set(KNOWN_CONTRACTS.map(k=>k.address.toLowerCase()));
        const xentAddr  = XENFT_ADDRESS.toLowerCase();
        const pxentAddr = NATIVE_XENFT.toLowerCase();

        let totalGasWei=0n;
        let totalWastedWei=0n;
        let revertedCount=0;
        const breakdown={
          proxyMint:0n, proxyClaim:0n,
          xentMint:0n, xentClaim:0n,
          pxentMint:0n, pxentClaim:0n,
          deploys:0n, other:0n,
        };
        const txCounts={
          proxyMint:0, proxyClaim:0,
          xentMint:0, xentClaim:0,
          pxentMint:0, pxentClaim:0,
          deploys:0, other:0,
        };

        for(const walletAddr of walletsToScan){
          const apiUrl=`https://api.scan.pulsechain.com/api/v2/addresses/${walletAddr}/transactions?filter=from`;
          const txRes=await fetch(apiUrl);
          const txJson=await txRes.json();
          if(!txJson.items)continue;

          for(const tx of txJson.items){
            const gasUsed=BigInt(tx.gas_used||0);
            const gasPrice=BigInt(tx.gas_price||0);
            const fee=gasUsed*gasPrice;

            // Reverts (still cost gas)
            if(tx.status!=="ok"){
              totalWastedWei+=fee;
              revertedCount++;
              continue;
            }

            const to=tx.to?.hash?.toLowerCase();
            // Contract creation tx (no `to` field) — counts toward deploys
            if(!to){
              breakdown.deploys+=fee; txCounts.deploys++;
              totalGasWei+=fee;
              continue;
            }

            const input=(tx.raw_input||"").toLowerCase();

            if(knownManagers.has(to)){
              if(input.startsWith("0xbb739814")){
                breakdown.proxyMint+=fee; txCounts.proxyMint++;
              }else if(input.startsWith("0x50416b93")||input.startsWith("0x05e98d64")){
                breakdown.proxyClaim+=fee; txCounts.proxyClaim++;
              }else{
                breakdown.other+=fee; txCounts.other++;
              }
              totalGasWei+=fee;
            }
            else if(to===xentAddr){
              if(input.startsWith("0xecef9201")){
                breakdown.xentMint+=fee; txCounts.xentMint++;
              }else if(input.startsWith("0x40fd0b75")){
                breakdown.xentClaim+=fee; txCounts.xentClaim++;
              }
              totalGasWei+=fee;
            }
            else if(to===pxentAddr){
              if(input.startsWith("0xecef9201")){
                breakdown.pxentMint+=fee; txCounts.pxentMint++;
              }else if(input.startsWith("0x40fd0b75")){
                breakdown.pxentClaim+=fee; txCounts.pxentClaim++;
              }
              totalGasWei+=fee;
            }
          }
        }

        const toPls=(wei)=>(Number(wei)/1e18).toFixed(4);
        const combinedTotal=totalGasWei+totalWastedWei;
        setMintGasUsed(toPls(combinedTotal));
        setGasBreakdown({
          total: toPls(combinedTotal),
          wastedOnReverts: toPls(totalWastedWei),
          revertedCount,
          proxyMint:  {pls: toPls(breakdown.proxyMint),  count: txCounts.proxyMint},
          proxyClaim: {pls: toPls(breakdown.proxyClaim), count: txCounts.proxyClaim},
          xentMint:   {pls: toPls(breakdown.xentMint),   count: txCounts.xentMint},
          xentClaim:  {pls: toPls(breakdown.xentClaim),  count: txCounts.xentClaim},
          pxentMint:  {pls: toPls(breakdown.pxentMint),  count: txCounts.pxentMint},
          pxentClaim: {pls: toPls(breakdown.pxentClaim), count: txCounts.pxentClaim},
          deploys:    {pls: toPls(breakdown.deploys),    count: txCounts.deploys},
          other:      {pls: toPls(breakdown.other),      count: txCounts.other},
        });
      }catch(err){console.warn("Gas tracker error:",err);}

      setLastCheck(new Date());
    }catch(e){showToast("Load error: "+e.message,C.pink);}
    finally{setLoading(false);}
  },[managerAddr,account]);

  // ── Load ALL proxies ─────────────────────────────────────────
  const loadAllProxies=useCallback(async(total)=>{
    if(!managerAddr||!total)return;
    setLoadingProxies(true);
    const rows=[];
    for(let i=0;i<total;i+=PROXY_BATCH){
      const batch=Array.from({length:Math.min(PROXY_BATCH,total-i)},(_,j)=>
        ethCall(managerAddr,"getMaturity(uint256)",[i+j])
      );
      const results=await Promise.all(batch);
      results.forEach((h,j)=>{
        const ts=decodeUint(h), now=Math.floor(Date.now()/1000);
        const daysLeft=ts>now?Math.ceil((ts-now)/86400):0;
        rows.push({id:i+j,daysLeft,matured:ts<=now&&ts>0,maturityTs:ts,
          maturityDate:ts>0?new Date(ts*1000).toLocaleDateString():"—",
          graceExpiry:new Date((ts+GRACE_DAYS*86400)*1000),
          // Unknown until we can read rank/amp from XEN — no fake numbers.
          estimatedXen:null,
          status:ts<=now&&ts>0?"READY":daysLeft<10?"SOON":"MINTING"});
      });
      setProxies([...rows]); // live update as batches load
    }
    setAllProxiesLoaded(true);
    setLoadingProxies(false);
  },[managerAddr]);

  useEffect(()=>{if(managerAddr&&account){loadData();}}, [managerAddr,account]);
  useEffect(()=>{if(cd?.totalProxies&&managerAddr&&account)loadAllProxies(cd.totalProxies);},[cd?.totalProxies]);

  // ── Send tx ──────────────────────────────────────────────────
  const sendTx=async(fnSig,params=[],label="Tx",gasPls=0)=>{
    let data="0x"+sel(fnSig);
    for(const p of params){
      if(typeof p==="boolean")data+=pad32(p?1:0);
      else if(typeof p==="string"&&p.startsWith("0x"))data+=p.slice(2).padStart(64,"0");
      else data+=pad32(p);
    }
    setTxPending(label);
    try{
      // Measure owner's pXEN balance before so we can derive real earned amount.
      const pxen = "0x8a7FDcA264e87b6da72D000f22186B4403081A2a"; // XEN (pXEN on PulseChain)
      let balBefore = 0n;
      try {
        const h = await ethCall(pxen, "balanceOf(address)", [account]);
        balBefore = BigInt(h || "0x0");
      } catch {}

      const hash=await window.ethereum.request({method:"eth_sendTransaction",
        params:[{from:account,to:managerAddr,data,gas:"0x7A1200"}]});
      showToast(`⏳ ${label} → ${short(hash)}`);

      // After ~6s (give the tx time to mine), read the new balance and compute delta.
      setTimeout(async ()=>{
        let earned = 0;
        try {
          const h = await ethCall(pxen, "balanceOf(address)", [account]);
          const balAfter = BigInt(h || "0x0");
          // pXEN has 18 decimals. Floor to integer XEN for display.
          const delta = balAfter > balBefore ? balAfter - balBefore : 0n;
          earned = Number(delta / 10n**18n);
        } catch {}
        setClaimHistory(h=>[{id:Date.now(),time:"just now",hash:short(hash),label,earned,gas:gasPls},...h.slice(0,19)]);
        setAnalytics(a=>({
          ...a, claimCount:a.claimCount+1, totalEarned:a.totalEarned+earned, totalGasPls:+(a.totalGasPls+gasPls).toFixed(4),
          chartData:[...a.chartData,{day:new Date().toLocaleDateString(),xen:earned,gas:gasPls}].slice(-30),
        }));
        loadData();
        setTxPending(null);
      },6000);
      return hash;
    }catch(e){
      setTxPending(null);
      if(e.code!==4001){showToast(`${label} failed: ${e.message}`,C.pink);throw e;}
      else showToast("Cancelled",C.amber);
    }
  };

  const handleClaim=async()=>{
    if(!cd?.maturedCount){showToast("No matured wallets",C.amber);return;}
    for(let i=0;i<cd.totalProxies;i+=50)
      await sendTx("batchClaim(uint256,uint256)",[i,Math.min(i+50,cd.totalProxies)],"Claim",0.05);
  };
  const handleCSR=async()=>{
    if(!cd?.maturedCount){showToast("No matured wallets",C.amber);return;}
    for(let i=0;i<cd.totalProxies;i+=50)
      await sendTx("batchClaimStakeAndRestart(uint256,uint256,bool)",[i,Math.min(i+50,cd.totalProxies),autoRestart],"Claim+Stake+Restart",0.07);
  };

  const MINT_BATCH = 5; // max wallets per tx (safe gas limit)

  const handleStartMint=async()=>{
    if(!managerAddr||!account){showToast("Connect wallet first",C.pink);return;}

    // Check wallet is actually the owner before attempting onlyOwner functions
    if(cd&&cd.owner&&cd.owner.toLowerCase()!==account.toLowerCase()){
      showToast(`❌ Only owner wallet can mint proxies. Switch to ${short(cd.owner)}`,C.pink);
      addLog(`✗ Aborted — you are ${short(account)} but owner is ${short(cd.owner)}`,"error");
      return;
    }

    setMinting(true);
    try{
      // Build calldata for every batch up front so EIP-5792 can submit them as one wallet call
      const calls=[];
      let queued=0;
      while(queued<mintCount){
        const batch=Math.min(MINT_BATCH, mintCount-queued);
        const data="0x"+sel("batchClaimRank(uint256,uint256)")+pad32(batch)+pad32(mintTerm);
        calls.push({to:managerAddr, data, count:batch});
        queued+=batch;
      }

      showToast(`Starting ${mintCount} wallets in ${calls.length} ${calls.length===1?"transaction":"transactions"}...`,C.cyan);

      // EIP-5792: probe wallet capability, then submit all batches in one popup if supported
      const PULSE_HEX="0x171";
      let usedBatched=false;
      let caps=null;
      try{
        caps=await window.ethereum.request({method:"wallet_getCapabilities",params:[account,[PULSE_HEX]]});
      }catch{ caps=null; }
      const chainCaps=caps?.[PULSE_HEX]||{};
      const supports5792 = chainCaps.atomic?.status==="supported"
                        || chainCaps.atomic?.status==="ready"
                        || chainCaps.atomicBatch?.supported===true;

      if(supports5792 && calls.length>1){
        try{
          setTxPending(`Submitting ${calls.length} batches as one EIP-5792 call`);
          addLog(`EIP-5792 supported — sending ${calls.length} batches as one wallet call`,"info");
          const result=await window.ethereum.request({
            method:"wallet_sendCalls",
            params:[{
              version:"2.0.0",
              from:account,
              chainId:PULSE_HEX,
              atomicRequired:false,
              calls:calls.map(c=>({to:c.to, data:c.data})),
            }],
          });
          const id=typeof result==="string"?result:result?.id;
          usedBatched=true;
          setMintModal(false);
          setTxPending(null);
          showToast(`✓ ${mintCount} wallets queued via EIP-5792 (${short(String(id||""))})`,C.green);
          addLog(`EIP-5792 batch submitted — id ${id||"?"}`,"success");
          pushNotif("XEN Minting Started",`${mintCount} wallets minting for ${mintTerm} days`);
          setTimeout(()=>loadData(),10000);
        }catch(e){
          if(e.code===4001){showToast("Cancelled",C.amber);return;}
          // 5792 was advertised but failed — fall through to legacy loop
          addLog(`EIP-5792 send failed, falling back to per-batch: ${e.message||"unknown"}`,"warning");
        }
      }

      if(!usedBatched){
        let deployed=0;
        let success=0;
        for(const c of calls){
          setTxPending(`Minting ${deployed+c.count}/${mintCount} wallets`);
          try{
            const hash=await window.ethereum.request({method:"eth_sendTransaction",
              params:[{from:account,to:managerAddr,data:c.data,gas:"0x7A1200"}]});
            await new Promise(r=>setTimeout(r,4000));
            deployed+=c.count;
            success+=c.count;
            showToast(`✓ ${deployed}/${mintCount} wallets deployed`,C.green);
          }catch(e){
            if(e.code===4001){showToast("Cancelled",C.amber);break;}
            showToast(`Batch failed: ${e.message}`,C.pink);
            break;
          }
        }
        setTxPending(null);
        if(success>0){
          setMintModal(false);
          showToast(`✓ ${success} wallets now minting pXEN for ${mintTerm} days!`,C.green);
          pushNotif("XEN Minting Started",`${success} wallets minting for ${mintTerm} days`);
          setTimeout(()=>loadData(),6000);
        }
      }
    }finally{setMinting(false);setTxPending(null);}
  };

  // ── Auto-claim with failure tracking ────────────────────────
  const runAutoCheck=useCallback(async()=>{
    setLastCheck(new Date());
    try{
      const mH=await ethCall(managerAddr,"maturedCount()");
      const matured=decodeUint(mH);
      await loadData();
      if(matured>0){
        showToast(`🤖 ${matured} wallets matured — auto-claiming`,C.amber);
        pushNotif("XEN Auto-Claim Triggered",`${matured} wallets matured on PulseChain`);
        await handleCSR();
        setFailCount(0);setLastError(null);
        pushNotif("✓ XEN Claimed!",`Rewards forwarded to your wallet`);
      }
    }catch(e){
      const fc=failCount+1;
      setFailCount(fc);setLastError(e.message);
      showToast(`Auto-claim failed (${fc}x): ${e.message}`,C.pink);
      if(fc>=3) pushNotif("⚠ XEN Auto-Claim Failing",`Failed ${fc} times. Check your dashboard!`);
    }
  },[managerAddr,failCount,loadData]);

  const startAuto=()=>{
    if(intervalRef.current)return;
    setAutoOn(true);setFailCount(0);setLastError(null);
    showToast(`🤖 Auto-claim started — every ${checkMins} min`,C.cyan);
    runAutoCheck();
    intervalRef.current=setInterval(runAutoCheck,checkMins*60*1000);
  };
  const stopAuto=()=>{
    if(intervalRef.current){clearInterval(intervalRef.current);intervalRef.current=null;}
    setAutoOn(false);showToast("Auto-claim stopped",C.amber);
  };
  // Restart auto when interval changes
  useEffect(()=>{
    if(autoOn){stopAuto();startAuto();}
  },[checkMins]);

  // ── Urgency: wallets nearing grace expiry ────────────────────
  const urgentProxies = proxies.filter(p=>{
    if(!p.matured)return false;
    const secsLeft=(p.graceExpiry-Date.now())/1000;
    return secsLeft>0&&secsLeft<86400*2; // < 2 days grace left
  });

  const filtered=proxies.filter(p=>filter==="ALL"||p.status===filter);
  const showDash=demoMode||(account&&managerAddr);

  // ════════════════════════════════════════════════════════════
  return(
    <div style={{minHeight:"100vh",background:"#020510",color:"#fff",fontFamily:"'Share Tech Mono',monospace",position:"relative",overflowX:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#00f5ff22}
        @keyframes scan{0%{top:-100px}100%{top:100vh}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        @keyframes glowPulse{0%,100%{text-shadow:0 0 20px #00f5ff55}50%{text-shadow:0 0 50px #00f5ffcc}}
        @keyframes toastIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0.15}}
        @keyframes urgentPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,45,120,0)}50%{box-shadow:0 0 0 4px rgba(255,45,120,0.2)}}
        .fade-up{animation:fadeUp 0.32s ease forwards}
        .glow{animation:glowPulse 3s ease infinite}
        .spin{animation:spin 1.2s linear infinite}
        .blink{animation:blink 1.5s ease infinite}
        input[type=range]{-webkit-appearance:none;height:3px;border-radius:2px;outline:none;cursor:pointer}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#00f5ff;box-shadow:0 0 8px #00f5ff88;cursor:pointer}
      `}</style>

      <HexGrid/>
      <div style={{position:"fixed",top:-200,left:-200,width:500,height:500,background:"radial-gradient(circle,rgba(0,245,255,0.05),transparent 65%)",pointerEvents:"none"}}/>
      <div style={{position:"fixed",bottom:-150,right:-150,width:400,height:400,background:"radial-gradient(circle,rgba(255,45,120,0.04),transparent 65%)",pointerEvents:"none"}}/>
      <div style={{position:"fixed",top:"40%",right:"-10%",width:350,height:350,background:"radial-gradient(circle,rgba(168,85,247,0.03),transparent 65%)",pointerEvents:"none"}}/>
      <div style={{position:"fixed",left:0,right:0,height:100,background:"linear-gradient(transparent,rgba(0,245,255,0.012),transparent)",animation:"scan 14s linear infinite",pointerEvents:"none",zIndex:40}}/>

      {toast&&<div style={{position:"fixed",top:16,right:16,zIndex:999,padding:"10px 16px",background:"rgba(2,5,20,0.97)",border:`1px solid ${toast.color}55`,color:toast.color,fontSize:10,letterSpacing:"0.08em",boxShadow:`0 0 20px ${toast.color}22`,animation:"toastIn 0.25s ease",maxWidth:"calc(100vw - 32px)"}}>{toast.msg}</div>}
      {txPending&&<div style={{position:"fixed",bottom:16,left:"50%",transform:"translateX(-50%)",zIndex:999,padding:"10px 20px",background:"rgba(2,5,20,0.97)",border:`1px solid ${C.amber}55`,color:C.amber,fontSize:10,letterSpacing:"0.1em",display:"flex",alignItems:"center",gap:10,whiteSpace:"nowrap"}}>
        <div className="spin" style={{width:12,height:12,border:`2px solid ${C.amber}44`,borderTop:`2px solid ${C.amber}`,borderRadius:"50%"}}/>{txPending}...
      </div>}

      {/* ── Failure alert banner ── */}
      {failCount>=3&&(
        <div style={{position:"fixed",top:0,left:0,right:0,zIndex:998,padding:"10px 20px",background:"rgba(255,45,120,0.12)",border:`1px solid ${C.pink}55`,color:C.pink,fontSize:10,letterSpacing:"0.08em",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,backdropFilter:"blur(8px)"}}>
          <span>⚠ Auto-claim has failed {failCount} times in a row — {lastError}</span>
          <div style={{display:"flex",gap:8,flexShrink:0}}>
            <NeonBtn color={C.pink} onClick={()=>{setFailCount(0);setLastError(null);}} small>Dismiss</NeonBtn>
            <NeonBtn color={C.amber} onClick={runAutoCheck} small>Retry Now</NeonBtn>
          </div>
        </div>
      )}

      {/* ── Urgent expiry banner ── */}
      {urgentProxies.length>0&&!demoMode&&(
        <div style={{position:"fixed",top:failCount>=3?40:0,left:0,right:0,zIndex:997,padding:"8px 20px",background:"rgba(255,184,0,0.1)",border:`1px solid ${C.amber}44`,color:C.amber,fontSize:10,letterSpacing:"0.08em",display:"flex",alignItems:"center",gap:8,backdropFilter:"blur(8px)"}}>
          ⏰ {urgentProxies.length} wallet{urgentProxies.length>1?"s":""} grace period expiring soon — claim now to avoid losing rewards
        </div>
      )}

      <div style={{maxWidth:1100,margin:"0 auto",paddingTop:`${(failCount>=3?40:0)+(urgentProxies.length>0?38:0)+28}px`,paddingBottom:"60px",paddingLeft:mobile?14:24,paddingRight:mobile?14:24,position:"relative"}}>

        {/* ── HEADER ── */}
        <div style={{paddingBottom:20}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:10}}>
                <div style={{position:"relative",width:38,height:38,flexShrink:0}}>
                  <div style={{position:"absolute",inset:0,border:`1.5px solid ${C.cyan}`,transform:"rotate(45deg)",boxShadow:`0 0 14px ${C.cyan}44`}}/>
                  <div style={{position:"absolute",inset:7,background:C.cyan,transform:"rotate(45deg)",boxShadow:`0 0 18px ${C.cyan}`,opacity:0.9}}/>
                </div>
                <div>
                  <div className="glow" style={{fontFamily:"'Rajdhani',sans-serif",fontSize:mobile?20:26,fontWeight:700,letterSpacing:"0.2em",color:"#fff",lineHeight:1}}>XEN TERMINAL</div>
                  <div style={{fontSize:8,letterSpacing:"0.22em",color:`${C.cyan}66`,marginTop:3}}>PULSECHAIN · MINT OPS · v2.0</div>
                </div>
              </div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                <Pill label={demoMode?"DEMO MODE":account?short(account):"NOT CONNECTED"} ok={demoMode||!!account}/>
                {!demoMode&&<Pill label={chainOk?"PULSECHAIN":"WRONG CHAIN"} ok={chainOk}/>}
                {autoOn&&<Pill label={`AUTO ${checkMins}MIN`} ok={true} blink/>}
                {failCount>0&&<Pill label={`FAIL ×${failCount}`} ok={false}/>}
                {notifPerms==="granted"&&<Pill label="NOTIFS ON" ok={true}/>}
                {!account&&!demoMode&&<div style={{marginLeft:4}}><NeonBtn color={C.cyan} onClick={connectWallet} disabled={connecting} small>{connecting?"Connecting...":"Connect Wallet"}</NeonBtn></div>}
                {demoMode&&<div style={{marginLeft:4}}><NeonBtn color={C.amber} onClick={exitDemo} small>Exit Demo</NeonBtn></div>}
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:mobile?22:32,fontWeight:700,color:C.cyan,textShadow:`0 0 22px ${C.cyan}55`,letterSpacing:"0.07em",lineHeight:1}}>{time.toLocaleTimeString()}</div>
              <div style={{fontSize:9,color:"rgba(255,255,255,0.2)",marginTop:3}}>{time.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}</div>
              {lastCheck&&<div style={{fontSize:8,color:`${C.cyan}44`,marginTop:2}}>checked {lastCheck.toLocaleTimeString()}</div>}
            </div>
          </div>
          <div style={{marginTop:16,height:1,background:`linear-gradient(90deg,${C.cyan}88,${C.pink}44,${C.purple}22,transparent)`}}/>
        </div>

        {/* ── NOT CONNECTED ── */}
        {!account&&!demoMode&&(
          <div className="fade-up">
            <GlowCard color={C.cyan} style={{padding:30,textAlign:"center",marginBottom:12}}>
              <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:24,color:C.cyan,marginBottom:10,textShadow:`0 0 20px ${C.cyan}`}}>Connect MetaMask</div>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.35)",marginBottom:22,lineHeight:1.7}}>Connect to PulseChain to read your XenMintManagerV2 contract and enable live auto-claiming.</div>
              <NeonBtn color={C.cyan} onClick={connectWallet} disabled={connecting} full>{connecting?"⏳ Connecting...":"⚡ Connect Wallet"}</NeonBtn>
            </GlowCard>
            <GlowCard color={C.purple} style={{padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:3}}>Just want to explore?</div>
                <div style={{fontSize:10,color:"rgba(255,255,255,0.25)"}}>Preview with sample data — no wallet needed.</div>
              </div>
              <NeonBtn color={C.purple} onClick={enterDemo}>👁 Preview Demo</NeonBtn>
            </GlowCard>
          </div>
        )}

        {/* ── NO CONTRACT ── */}
        {account&&!managerAddr&&!demoMode&&(
          <div className="fade-up">
            <GlowCard color={C.cyan} style={{padding:24,marginBottom:12}}>
              <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,color:C.cyan,marginBottom:6}}>Choose Contract</div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",marginBottom:14}}>Pick a known deployment or paste a custom XenMintManager address.</div>
              <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
                {KNOWN_CONTRACTS.map(k=>(
                  <NeonBtn key={k.address} color={C.cyan} onClick={()=>switchManager(k.address)}>
                    {k.label} — {k.note}
                  </NeonBtn>
                ))}
              </div>
              <input value={inputAddr} onChange={e=>setInputAddr(e.target.value)} placeholder="0x... (custom address)"
                style={{width:"100%",padding:"10px 12px",background:"rgba(0,245,255,0.05)",border:`1px solid ${C.cyan}33`,color:"#fff",fontSize:12,fontFamily:"inherit",outline:"none",marginBottom:10,letterSpacing:"0.04em"}}/>
              <NeonBtn color={C.cyan} onClick={()=>{
                if(inputAddr.startsWith("0x")&&inputAddr.length===42){
                  switchManager(inputAddr);
                }else showToast("Invalid address",C.pink);
              }} full>Load Contract →</NeonBtn>
            </GlowCard>
            <GlowCard color={C.purple} style={{padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>No contract yet? Preview first.</div>
              <NeonBtn color={C.purple} onClick={enterDemo}>👁 Preview Demo</NeonBtn>
            </GlowCard>
          </div>
        )}

        {/* ── MAIN DASHBOARD ── */}
        {showDash&&(
          <>
            {demoMode&&(
              <div style={{marginBottom:12,padding:"8px 14px",background:"rgba(168,85,247,0.08)",border:"1px solid rgba(168,85,247,0.25)",fontSize:10,color:`${C.purple}cc`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                <span>👁 DEMO MODE — sample data, no real transactions</span>
                <NeonBtn color={C.purple} onClick={exitDemo} small>Exit Demo</NeonBtn>
              </div>
            )}

            {/* Tabs */}
            <div style={{display:"flex",borderBottom:"1px solid rgba(0,245,255,0.07)",marginBottom:20,overflowX:"auto"}}>
              {["overview","proxies","xenfts","pxent","auto-claim","analytics","settings"].map(t=>(
                <div key={t} onClick={()=>setTab(t)} style={{
                  padding:`10px ${mobile?11:18}px`,fontSize:9,letterSpacing:"0.16em",textTransform:"uppercase",cursor:"pointer",
                  color:tab===t?C.cyan:"rgba(255,255,255,0.24)",
                  borderBottom:tab===t?`2px solid ${C.cyan}`:"2px solid transparent",
                  marginBottom:-1,textShadow:tab===t?`0 0 10px ${C.cyan}`:"none",
                  transition:"all 0.2s",whiteSpace:"nowrap",flexShrink:0,
                }}>
                  {t}
                  {t==="auto-claim"&&autoOn&&<span className="blink" style={{marginLeft:4,color:C.green}}>●</span>}
                  {t==="auto-claim"&&failCount>=3&&<span style={{marginLeft:4,color:C.pink}}>!</span>}
                  {t==="xenfts"&&xenfts.length>0&&<span style={{marginLeft:4,fontSize:8,color:C.purple,border:`1px solid ${C.purple}44`,padding:"1px 4px",background:`${C.purple}0e`}}>{xenfts.length}</span>}
                  {t==="pxent"&&nativeXenfts.length>0&&<span style={{marginLeft:4,fontSize:8,color:C.pink,border:`1px solid ${C.pink}44`,padding:"1px 4px",background:`${C.pink}0e`}}>{nativeXenfts.length}</span>}
                  {t==="proxies"&&cd?.maturedCount>0&&<span style={{marginLeft:4,fontSize:8,color:C.green,border:`1px solid ${C.green}44`,padding:"1px 4px",background:`${C.green}0e`}}>{cd.maturedCount}</span>}
                </div>
              ))}
            </div>

            {loading&&<div style={{textAlign:"center",padding:14,color:`${C.cyan}55`,fontSize:10,letterSpacing:"0.1em"}}>Loading chain data...</div>}

            {/* ══ OVERVIEW ══ */}
            {tab==="overview"&&cd&&(
              <div className="fade-up">
                {/* Owner mismatch warning */}
                {cd.owner&&account&&cd.owner.toLowerCase()!==account.toLowerCase()&&(
                  <GlowCard color={C.amber} style={{padding:"12px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                    <div style={{fontSize:18}}>⚠️</div>
                    <div style={{flex:1,minWidth:200}}>
                      <div style={{fontSize:11,color:C.amber,marginBottom:2}}>Not owner wallet</div>
                      <div style={{fontSize:9,color:"rgba(255,255,255,0.4)"}}>Connected: {short(account)} · Owner: {short(cd.owner)}. Switch to owner for proxy mint/claim/stake actions.</div>
                    </div>
                  </GlowCard>
                )}
                {(()=>{
                  const plsPrice=prices.pls||0;
                  const xenPrice=prices.xen||0;
                  const pxenPrice=prices.pxen||0;

                  // Costs
                  const plsSpent=gasBreakdown?parseFloat(gasBreakdown.total):0;
                  const costUsd=plsSpent*plsPrice;

                  // Current EARNINGS (tokens earned from minting, NOT PLS reserve)
                  const forkXenVal=parseFloat(forkXenBal)*xenPrice;
                  const pxenVal=parseFloat(xenBal)*pxenPrice;
                  const earnedNow=forkXenVal+pxenVal;

                  // PLS balance is shown separately — it was your capital, not profit
                  const plsReserveUsd=parseFloat(plsBal)*plsPrice;

                  // Projected Apr 21 harvest
                  const projectedXen=995000;  // est XEN from 23 XENTs
                  const projectedPxen=170000; // est pXEN from proxies + 4 pXENTs
                  const projectedHarvest=(projectedXen*xenPrice)+(projectedPxen*pxenPrice);

                  // Total earned projected
                  const totalEarnedProjected=earnedNow+projectedHarvest;

                  // P&L = earnings - cost (ignores unspent PLS)
                  const pnl=totalEarnedProjected-costUsd;
                  const pnlPct=costUsd>0?((pnl/costUsd)*100):0;

                  return (
                    <GlowCard color={pnl>=0?C.green:C.pink} style={{padding:"18px 18px",marginBottom:12}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
                        <div>
                          <div style={{fontSize:9,letterSpacing:"0.2em",color:`${pnl>=0?C.green:C.pink}66`,marginBottom:4}}>💰 PROFIT & LOSS</div>
                          <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:26,fontWeight:700,color:pnl>=0?C.green:C.pink,lineHeight:1}}>
                            {pnl>=0?"+":""}${pnl.toFixed(2)} <span style={{fontSize:14,opacity:0.7}}>USD</span>
                          </div>
                          <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",marginTop:4}}>
                            {pnl>=0?"+":""}{pnlPct.toFixed(1)}% projected ROI after Apr 21
                          </div>
                        </div>
                        <NeonBtn color={C.cyan} onClick={loadPrices} small>↻ Refresh</NeonBtn>
                      </div>

                      {!prices.loaded&&(
                        <div style={{fontSize:10,color:C.amber,padding:"8px 12px",background:`${C.amber}11`,marginBottom:10}}>
                          ⏳ Loading live prices from PulseX...
                        </div>
                      )}

                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,borderTop:`1px solid ${C.green}22`,paddingTop:12}}>
                        {/* Spent */}
                        <div>
                          <div style={{fontSize:9,letterSpacing:"0.15em",color:"rgba(255,255,255,0.3)",marginBottom:6}}>SPENT (GAS)</div>
                          <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:C.pink}}>${costUsd.toFixed(2)}</div>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:2}}>{plsSpent.toLocaleString(undefined,{maximumFractionDigits:0})} PLS</div>
                        </div>

                        {/* Earned now */}
                        <div>
                          <div style={{fontSize:9,letterSpacing:"0.15em",color:"rgba(255,255,255,0.3)",marginBottom:6}}>EARNED (CLAIMED)</div>
                          <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:C.cyan}}>${earnedNow.toFixed(2)}</div>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:2}}>XEN + pXEN tokens</div>
                        </div>

                        {/* Projected after Apr 21 */}
                        <div>
                          <div style={{fontSize:9,letterSpacing:"0.15em",color:"rgba(255,255,255,0.3)",marginBottom:6}}>PROJECTED</div>
                          <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:C.amber}}>${totalEarnedProjected.toFixed(2)}</div>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:2}}>After Apr 21 harvest</div>
                        </div>
                      </div>

                      {/* PLS reserve info */}
                      <div style={{marginTop:10,padding:"8px 10px",background:`${C.green}08`,border:`1px solid ${C.green}22`,fontSize:10,color:"rgba(255,255,255,0.4)"}}>
                        <span style={{color:C.green}}>💼 PLS Reserve:</span> {parseFloat(plsBal).toLocaleString(undefined,{maximumFractionDigits:0})} PLS (${plsReserveUsd.toFixed(2)}) — your original capital, not counted in P&L
                      </div>

                      {/* Live prices sub-row */}
                      <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid ${C.green}11`,display:"flex",gap:14,flexWrap:"wrap",fontSize:10,color:"rgba(255,255,255,0.4)"}}>
                        {(()=>{
                          // Format tiny numbers with compact decimal notation
                          // Example: 0.00000002783 -> $0.0₍₁₀₎2783
                          const subscript={'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉'};
                          const toSub=(n)=>String(n).split('').map(c=>subscript[c]||c).join('');
                          const fmt=(v)=>{
                            if(!v||v<=0)return "—";
                            if(v>=1)return "$"+v.toFixed(4);
                            if(v>=0.0001)return "$"+v.toFixed(6);
                            // For tiny values, show as 0.0{count}XXXX
                            const s=v.toFixed(20);
                            const match=s.match(/^0\.(0+)(\d{1,4})/);
                            if(match&&match[1].length>=4){
                              return "$0.0"+toSub(match[1].length)+match[2];
                            }
                            return "$"+v.toFixed(10);
                          };
                          return (<>
                            <span>PLS: <span style={{color:C.green}}>{fmt(plsPrice)}</span></span>
                            <span>XEN: <span style={{color:C.amber}}>{fmt(xenPrice)}</span></span>
                            <span>pXEN: <span style={{color:C.cyan}}>{fmt(pxenPrice)}</span></span>
                          </>);
                        })()}
                      </div>
                    </GlowCard>
                  );
                })()}

                {/* Token balances row — the two XEN tokens separately */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                  <StatCard label="XEN (from XENTs)"  value={parseInt(forkXenBal).toLocaleString()} sub="0x06450dEe... Ethereum fork"  icon="💎" color={C.amber} animate/>
                  <StatCard label="pXEN (from proxies + pXENT)" value={parseInt(xenBal).toLocaleString()} sub="0x8a7FDc... native PulseChain" icon="💠" color={C.cyan}  animate/>
                </div>
                {/* Operations row */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
                  <StatCard label="Total Proxies" value={cd.totalProxies}                   sub={`${cd.maturedCount} ready`} icon="⬡" color={C.purple} animate/>
                  <StatCard label="Maturing Soon" value={cd.maturingSoon}                   sub="within 3 days"          icon="⏳" color={C.pink}   animate/>
                  <StatCard label="PLS Reserve"   value={plsBal}                            sub="gas balance"            icon="⚡" color={C.green}/>
                </div>
                {gasBreakdown&&parseFloat(gasBreakdown.total)>0&&(
                  <GlowCard color={C.amber} style={{padding:"16px 16px",marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
                      <div>
                        <div style={{fontSize:9,letterSpacing:"0.15em",color:`${C.amber}66`,marginBottom:4}}>⛽ TOTAL PLS SPENT</div>
                        <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:28,fontWeight:700,color:C.amber,textShadow:`0 0 16px ${C.amber}55`,lineHeight:1}}>{gasBreakdown.total} <span style={{fontSize:14,opacity:0.6}}>PLS</span></div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:9,color:"rgba(255,255,255,0.35)",marginBottom:2}}>all-time gas across</div>
                        <div style={{fontSize:9,color:"rgba(255,255,255,0.35)"}}>minting + claiming</div>
                      </div>
                    </div>

                    {/* Breakdown */}
                    <div style={{borderTop:`1px solid ${C.amber}22`,paddingTop:12}}>
                      <div style={{fontSize:8,letterSpacing:"0.18em",color:`${C.amber}55`,marginBottom:10}}>BREAKDOWN</div>
                      {[
                        {k:"Proxy mints",      val:gasBreakdown.proxyMint,  c:C.cyan,                       icon:"⬡"},
                        {k:"Proxy claims",     val:gasBreakdown.proxyClaim, c:C.green,                      icon:"⛏"},
                        {k:"XENT mints",       val:gasBreakdown.xentMint,   c:C.purple,                     icon:"🖼"},
                        {k:"XENT claims",      val:gasBreakdown.xentClaim,  c:C.green,                      icon:"⛏"},
                        {k:"pXENT mints",      val:gasBreakdown.pxentMint,  c:C.pink,                       icon:"🌱"},
                        {k:"pXENT claims",     val:gasBreakdown.pxentClaim, c:C.green,                      icon:"⛏"},
                        {k:"Contract deploys", val:gasBreakdown.deploys,    c:C.amber,                      icon:"📦"},
                        {k:"Setup / config",   val:gasBreakdown.other,      c:"rgba(255,255,255,0.5)",      icon:"⚙"},
                      ].filter(r=>r.val&&r.val.count>0).map(r=>(
                        <div key={r.k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,fontSize:11}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:12}}>{r.icon}</span>
                            <span style={{color:"rgba(255,255,255,0.5)"}}>{r.k}</span>
                            <span style={{fontSize:9,color:"rgba(255,255,255,0.25)"}}>×{r.val.count}</span>
                          </div>
                          <span style={{color:r.c,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.val.pls} PLS</span>
                        </div>
                      ))}
                    </div>

                    {/* Per-unit costs */}
                    <div style={{borderTop:`1px solid ${C.amber}22`,marginTop:10,paddingTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,fontSize:10}}>
                      {gasBreakdown.proxyMint.count>0&&(
                        <div style={{color:"rgba(255,255,255,0.3)"}}>
                          <span style={{color:C.cyan}}>{(parseFloat(gasBreakdown.proxyMint.pls)/gasBreakdown.proxyMint.count).toFixed(4)}</span> PLS avg per proxy mint
                        </div>
                      )}
                      {(gasBreakdown.xentMint.count>0||gasBreakdown.pxentMint.count>0)&&(
                        <div style={{color:"rgba(255,255,255,0.3)"}}>
                          <span style={{color:C.purple}}>{(((parseFloat(gasBreakdown.xentMint.pls)+parseFloat(gasBreakdown.pxentMint.pls))/(gasBreakdown.xentMint.count+gasBreakdown.pxentMint.count))||0).toFixed(4)}</span> PLS avg per XENFT
                        </div>
                      )}
                    </div>
                  </GlowCard>
                )}

                {/* Legacy simple gas card if no breakdown yet */}
                {!gasBreakdown&&mintGasUsed&&parseFloat(mintGasUsed)>0&&(
                  <GlowCard color={C.amber} style={{padding:"12px 16px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontSize:9,letterSpacing:"0.15em",color:`${C.amber}66`,marginBottom:4}}>PLS SPENT ON MINTING</div>
                      <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:22,fontWeight:700,color:C.amber,textShadow:`0 0 16px ${C.amber}55`}}>{mintGasUsed} <span style={{fontSize:13,opacity:0.6}}>PLS</span></div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:9,color:"rgba(255,255,255,0.25)",marginBottom:2}}>across {cd.totalProxies} proxy deployments</div>
                      <div style={{fontSize:9,color:"rgba(255,255,255,0.25)"}}>~{(parseFloat(mintGasUsed)/cd.totalProxies).toFixed(5)} PLS per wallet</div>
                    </div>
                  </GlowCard>
                )}

                {urgentProxies.length>0&&(
                  <GlowCard color={C.pink} style={{padding:"12px 16px",marginBottom:12,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                    <div style={{fontSize:18}}>⚠️</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11,color:C.pink,marginBottom:2}}>{urgentProxies.length} wallet{urgentProxies.length>1?"s":""} nearing grace expiry</div>
                      <div style={{fontSize:10,color:"rgba(255,255,255,0.3)"}}>Claim now — rewards drop to zero after 7 days</div>
                    </div>
                    <NeonBtn color={C.pink} onClick={demoMode?()=>showToast("Demo mode",C.purple):handleCSR} small>Claim Now</NeonBtn>
                  </GlowCard>
                )}

                <GlowCard color={C.cyan} style={{padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                  <div style={{fontSize:9,color:`${C.cyan}55`,letterSpacing:"0.14em"}}>CONTRACT</div>
                  <div style={{fontSize:10,color:`${C.cyan}88`}}>{demoMode?"0x8a7F...2a2a":short(managerAddr)}</div>
                  <NeonBtn color={C.cyan} onClick={demoMode?()=>{}:loadData} disabled={loading} small>↻ Refresh</NeonBtn>
                </GlowCard>

                <GlowCard color={C.cyan} style={{padding:"16px 14px",marginBottom:12}}>
                  <div style={{fontSize:9,letterSpacing:"0.2em",color:`${C.cyan}55`,marginBottom:16}}>WALLET STATUS</div>
                  <div style={{display:"flex",justifyContent:"space-around",gap:4}}>
                    <RingChart value={cd.maturedCount} max={Math.max(cd.totalProxies,1)} color={C.green}  label="READY"    sub="claim"/>
                    <RingChart value={cd.maturingSoon} max={Math.max(cd.totalProxies,1)} color={C.amber}  label="SOON"     sub="< 3d"/>
                    <RingChart value={Math.max(0,cd.totalProxies-cd.maturedCount-cd.maturingSoon)} max={Math.max(cd.totalProxies,1)} color={C.cyan} label="MINTING" sub="active"/>
                    <RingChart value={cd.totalProxies} max={500}                          color={C.purple} label="CAPACITY" sub="of 500"/>
                  </div>
                </GlowCard>

                <GlowCard color={C.green} style={{padding:"16px 14px",marginBottom:12}}>
                  <div style={{fontSize:9,letterSpacing:"0.2em",color:`${C.green}55`,marginBottom:12}}>ACTIONS</div>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    <NeonBtn color={C.cyan}  onClick={()=>setMintModal(true)} full>⬡ Start New Mint (Proxy)</NeonBtn>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                      <NeonBtn color={C.amber} onClick={()=>setXenftModal(true)} full>🖼 Mint XENT (→XEN)</NeonBtn>
                      <NeonBtn color={C.pink}  onClick={()=>setNativeModal(true)} full>🌱 Mint pXENT (→pXEN)</NeonBtn>
                    </div>
                    <NeonBtn color={C.green}  onClick={demoMode?()=>showToast("Demo mode — connect wallet",C.purple):handleClaim}  disabled={!!txPending||!cd.maturedCount} full>⛏ Claim {cd.maturedCount} Matured Wallets</NeonBtn>
                    <NeonBtn color={C.purple} onClick={demoMode?()=>showToast("Demo mode — connect wallet",C.purple):handleCSR}    disabled={!!txPending||!cd.maturedCount} full>⚡ Claim + Stake + Restart</NeonBtn>
                    <NeonBtn color={autoOn?C.pink:C.purple} onClick={demoMode?()=>showToast("Demo mode — connect wallet",C.purple):autoOn?stopAuto:startAuto} full>
                      {autoOn?"⏹ Stop Auto-Claim":"🤖 Enable Auto-Claim"}
                    </NeonBtn>
                  </div>
                </GlowCard>

                <GlowCard color={C.purple} style={{padding:"16px 14px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.2em",color:`${C.purple}55`,marginBottom:14}}>MATURITY DISTRIBUTION</div>
                  {[
                    {label:"Matured",count:cd.maturedCount,color:C.green},
                    {label:"0–10 days",count:cd.maturingSoon,color:C.amber},
                    {label:"10–60 days",count:Math.max(0,Math.floor(cd.totalProxies*0.36)),color:C.cyan},
                    {label:"60–100 days",count:Math.max(0,cd.totalProxies-cd.maturedCount-cd.maturingSoon-Math.floor(cd.totalProxies*0.36)),color:C.purple},
                  ].map(r=>(
                    <div key={r.label} style={{marginBottom:12}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                        <span style={{fontSize:10,color:"rgba(255,255,255,0.38)"}}>{r.label}</span>
                        <span style={{fontSize:10,color:r.color}}>{r.count}</span>
                      </div>
                      <div style={{height:3,background:"rgba(255,255,255,0.05)",borderRadius:2}}>
                        <div style={{height:"100%",width:`${Math.max(2,(r.count/Math.max(cd.totalProxies,1))*100)}%`,background:`linear-gradient(90deg,${r.color}55,${r.color})`,borderRadius:2,boxShadow:`0 0 7px ${r.color}44`,transition:"width 0.8s"}}/>
                      </div>
                    </div>
                  ))}
                </GlowCard>
              </div>
            )}

            {/* ══ PROXIES ══ */}
            {tab==="proxies"&&(
              <div className="fade-up">
                <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
                  {["ALL","READY","SOON","MINTING"].map(f=>(
                    <NeonBtn key={f} color={f==="ALL"?C.cyan:statusColor(f)} onClick={()=>setFilter(f)}>
                      {f}{f==="ALL"?` (${proxies.length})`:f==="READY"?` (${cd?.maturedCount||0})`:""}
                    </NeonBtn>
                  ))}
                  <span style={{marginLeft:"auto",fontSize:9,color:"rgba(255,255,255,0.2)"}}>
                    {loadingProxies?`Loading... ${proxies.length}/${cd?.totalProxies}`
                      :allProxiesLoaded?`${proxies.length} total`:""}
                  </span>
                </div>
                {loadingProxies&&(
                  <div style={{height:2,background:"rgba(255,255,255,0.05)",borderRadius:1,marginBottom:10}}>
                    <div style={{height:"100%",width:`${(proxies.length/Math.max(cd?.totalProxies||1,1))*100}%`,background:`linear-gradient(90deg,${C.cyan}55,${C.cyan})`,transition:"width 0.3s",borderRadius:1}}/>
                  </div>
                )}
                <GlowCard color={C.cyan} style={{overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"28px 1fr 58px 80px",gap:8,padding:"8px 14px",borderBottom:"1px solid rgba(0,245,255,0.07)",fontSize:8,letterSpacing:"0.1em",color:"rgba(255,255,255,0.2)"}}>
                    <span>#</span><span>PROGRESS / GRACE TIMER</span><span>STATUS</span><span style={{textAlign:"right"}}>EST XEN</span>
                  </div>
                  <div style={{maxHeight:500,overflowY:"auto"}}>
                    {filtered.length===0&&(
                      <div style={{padding:24,textAlign:"center",fontSize:11,color:"rgba(255,255,255,0.2)"}}>
                        {loadingProxies
                          ? `Loading proxies... ${proxies.length}/${cd?.totalProxies||"?"}`
                          : !allProxiesLoaded
                              ? "Waiting for on-chain data..."
                              : proxies.length===0
                                  ? "No proxies in this manager yet."
                                  : `No proxies match filter "${filter}".`}
                      </div>
                    )}
                    {filtered.map(p=><ProxyRow key={p.id} proxy={p}/>)}
                  </div>
                </GlowCard>
              </div>
            )}

            {/* ══ XENFTS ══ */}
            {tab==="xenfts"&&(
              <div className="fade-up">
                {/* Header */}
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,color:C.purple,textShadow:`0 0 12px ${C.purple}`}}>XEN Torrent NFTs (OG XENT)</div>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.25)",marginTop:2}}>OG XEN · ERC-721 · {XENFT_ADDRESS.slice(0,8)}...{XENFT_ADDRESS.slice(-4)} · Use og.xen.network</div>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <NeonBtn color={C.cyan} onClick={demoMode?()=>{}:loadXENFTs} disabled={xenftLoading} small>↻ Refresh</NeonBtn>
                    <NeonBtn color={C.amber} onClick={()=>window.open("https://og.xen.network/pulse-chain-og/xenft/torrent","_blank")} small>🔗 og.xen.network</NeonBtn>
                    {(() => {
                      const claimable = xenfts.filter(x => !x.redeemed);
                      return (
                        <NeonBtn color={C.green} onClick={handleClaimAllXents} disabled={!!txPending || claimable.length === 0}>
                          ⛏ Claim XEN ({claimable.length})
                        </NeonBtn>
                      );
                    })()}
                    <NeonBtn color={C.purple} onClick={()=>setXenftModal(true)}>🖼 Mint XENFTs</NeonBtn>
                  </div>
                </div>

                {/* Info + stats */}
                <GlowCard color={C.purple} style={{padding:"14px 16px",marginBottom:12}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",lineHeight:1.7}}>
                      <span style={{color:C.purple}}>Each XENFT</span> bundles multiple VMUs into one tradeable NFT. Sell before maturity on any NFT marketplace.
                    </div>
                    <div>
                      {[
                        {k:"Your XENFTs",  v:demoMode?DEMO_XENFTS.length:xenfts.length,  c:C.purple},
                        {k:"Ready",        v:demoMode?1:xenfts.filter(x=>x.matured).length, c:C.green},
                        {k:"Contract",     v:"XENT verified",                               c:"rgba(255,255,255,0.4)"},
                      ].map(r=>(
                        <div key={r.k} style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:10}}>
                          <span style={{color:"rgba(255,255,255,0.28)"}}>{r.k}</span>
                          <span style={{color:r.c,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </GlowCard>

                {/* Transaction logs */}
                {xenftLogs.length>0&&(
                  <GlowCard color={C.green} style={{padding:"14px 16px",marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                      <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.green}77`}}>▶ TRANSACTION LOGS ({xenftLogs.length})</div>
                      <NeonBtn color={C.pink} onClick={()=>setXenftLogs([])} small>Clear</NeonBtn>
                    </div>
                    <div style={{maxHeight:250,overflowY:"auto",background:"rgba(0,0,0,0.4)",border:"1px solid rgba(0,255,136,0.08)",padding:"8px 10px",fontFamily:"'Share Tech Mono',monospace",fontSize:10,lineHeight:1.6}}>
                      {xenftLogs.map(log=>{
                        const col = log.type==="success"?C.green : log.type==="error"?C.pink : log.type==="warning"?C.amber : log.type==="pending"?C.cyan : "rgba(255,255,255,0.5)";
                        const prefix = log.type==="success"?"✓" : log.type==="error"?"✗" : log.type==="warning"?"⚠" : log.type==="pending"?"⏳" : "›";
                        return(
                          <div key={log.id} style={{marginBottom:4,display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                            <span style={{color:"rgba(255,255,255,0.25)",flexShrink:0,fontSize:9}}>{log.time}</span>
                            <span style={{color:col,flexShrink:0}}>{prefix}</span>
                            <span style={{color:col,flex:1,wordBreak:"break-word",minWidth:0}}>{log.msg}</span>
                            {log.hash&&(
                              <a href={`https://scan.pulsechain.com/tx/${log.hash}`} target="_blank" rel="noopener noreferrer"
                                style={{color:`${C.cyan}aa`,fontSize:9,textDecoration:"none",flexShrink:0}}>
                                {short(log.hash)} ↗
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </GlowCard>
                )}

                {xenftLoading&&<div style={{textAlign:"center",padding:20,fontSize:10,color:`${C.purple}66`}}>Loading XENFTs...</div>}

                {/* Empty state */}
                {!xenftLoading&&(demoMode?DEMO_XENFTS:xenfts).length===0&&(
                  <GlowCard color={C.purple} style={{padding:28,textAlign:"center",marginBottom:12}}>
                    <div style={{fontSize:28,marginBottom:10}}>🖼</div>
                    <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,color:C.purple,marginBottom:6}}>No XENFTs yet</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",marginBottom:16}}>Mint your first XENFT — one NFT bundles up to 128 VMUs minting simultaneously.</div>
                    <NeonBtn color={C.purple} onClick={()=>setXenftModal(true)} full>🖼 Mint First XENFT</NeonBtn>
                  </GlowCard>
                )}

                {/* XENFT cards
                    Three states:
                      - REDEEMED: already claimed (gray, no actions)
                      - READY: not redeemed AND past chain maturity (green, claim + grace timer)
                      - MATURING: not redeemed AND pre-maturity (cyan, claim still allowed [contract is lenient near maturity], countdown timer) */}
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {(demoMode?DEMO_XENFTS:xenfts).map(nft=>{
                    const nowSec=Math.floor(Date.now()/1000);
                    const trulyMatured=nft.maturityTs>0&&nowSec>=nft.maturityTs;
                    const isRedeemed=!!nft.redeemed;
                    const state=isRedeemed?"REDEEMED":trulyMatured?"READY":"MATURING";
                    const stateColor={REDEEMED:"rgba(255,255,255,0.35)",READY:C.green,MATURING:C.cyan}[state];
                    const graceSecsLeft=(nft.graceExpiry-Date.now())/1000;
                    const graceUrgent=state==="READY"&&graceSecsLeft<86400*2;
                    return(
                      <GlowCard key={nft.tokenId} color={stateColor} style={{padding:"16px 16px",opacity:isRedeemed?0.55:1}}>
                        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
                          <div style={{flex:1}}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                              <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:stateColor}}>XENFT #{nft.tokenId}</div>
                              <span style={{fontSize:8,padding:"2px 7px",color:stateColor,border:`1px solid ${stateColor}44`,background:`${stateColor}0e`}}>
                                {state==="REDEEMED"?"✓ REDEEMED":state}
                              </span>
                            </div>
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                              {[
                                {k:"VMUs",      v:nft.vmus||"?"},
                                {k:"Term",      v:nft.term&&nft.term!=="?"?`${nft.term}d`:"—"},
                                {k:"Matures On",v:nft.maturityDate||"—"},
                                {k:"Est. XEN",  v:nft.estXen?fmtN(nft.estXen):"—"},
                              ].map(r=>(
                                <div key={r.k} style={{fontSize:10}}>
                                  <span style={{color:"rgba(255,255,255,0.28)"}}>{r.k}: </span>
                                  <span style={{color:"rgba(255,255,255,0.7)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v}</span>
                                </div>
                              ))}
                            </div>
                            {state==="MATURING"&&nft.maturityTs>0&&(
                              <div style={{marginTop:10,padding:"8px 12px",background:`${C.cyan}08`,border:`1px solid ${C.cyan}22`}}>
                                <div style={{fontSize:8,letterSpacing:"0.15em",color:`${C.cyan}66`,marginBottom:4}}>TIME UNTIL MATURITY</div>
                                <div style={{fontSize:14,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>
                                  <Countdown targetDate={new Date(nft.maturityTs*1000)}/>
                                </div>
                                <div style={{fontSize:9,color:"rgba(255,255,255,0.35)",marginTop:4}}>
                                  Early claim works for OG XENFT — usually within ~12h of maturity.
                                </div>
                              </div>
                            )}
                            {state==="READY"&&(
                              <div style={{marginTop:8,fontSize:10,color:graceUrgent?C.pink:C.amber}}>
                                {graceUrgent?"⚠ Grace expiring soon: ":"Grace period: "}
                                <Countdown targetDate={nft.graceExpiry}/>
                              </div>
                            )}
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:6}}>
                            {!isRedeemed&&(
                              <NeonBtn color={state==="READY"?C.green:C.cyan}
                                onClick={demoMode?()=>showToast("Demo mode",C.purple):()=>handleClaimXENFT(nft.tokenId)}
                                disabled={!!txPending}>
                                ⛏ Claim XEN
                              </NeonBtn>
                            )}
                            <NeonBtn color={C.purple} onClick={()=>window.open(`https://og.xen.network/pulse-chain-og/xenft/torrent`,"_blank")} small>
                              View ↗
                            </NeonBtn>
                          </div>
                        </div>
                        {state==="MATURING"&&nft.daysLeft>0&&(
                          <div style={{marginTop:10}}>
                            <div style={{height:2,background:"rgba(255,255,255,0.05)",borderRadius:1}}>
                              <div style={{height:"100%",width:`${Math.max(2,((nft.term-nft.daysLeft)/Math.max(nft.term,1))*100)}%`,background:`linear-gradient(90deg,${C.cyan}55,${C.cyan})`,borderRadius:1}}/>
                            </div>
                          </div>
                        )}
                      </GlowCard>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ══ pXENT (xen.network XENFT) ══ */}
            {tab==="pxent"&&(
              <div className="fade-up">
                {/* Header */}
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,color:C.pink,textShadow:`0 0 12px ${C.pink}`}}>XEN Torrent (pXENT)</div>
                    <div style={{fontSize:9,color:"rgba(255,255,255,0.25)",marginTop:2}}>Native pXENT · {NATIVE_XENFT.slice(0,8)}...{NATIVE_XENFT.slice(-4)} · Use xen.network/pulse-chain</div>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <NeonBtn color={C.cyan} onClick={loadNativeData} disabled={nativeLoading} small>↻ Refresh</NeonBtn>
                    <NeonBtn color={C.amber} onClick={()=>window.open("https://xen.network/pulse-chain/xenft/torrent","_blank")} small>🔗 xen.network</NeonBtn>
                    {nativeXenfts.filter(x=>x.matured).length>0&&(
                      <NeonBtn color={C.green} onClick={handleClaimAllPxents} disabled={!!txPending}>
                        ⛏ Claim All ({nativeXenfts.filter(x=>x.matured).length})
                      </NeonBtn>
                    )}
                    <NeonBtn color={C.pink} onClick={()=>setNativeModal(true)}>🖼 Mint pXENTs</NeonBtn>
                  </div>
                </div>

                {/* Info + stats */}
                <GlowCard color={C.pink} style={{padding:"14px 16px",marginBottom:12}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",lineHeight:1.7}}>
                      <span style={{color:C.pink}}>pXENT</span> is the newer XENFT contract supported by <span style={{color:C.pink}}>xen.network/pulse-chain</span>. Like XENT, it also rewards pXEN tokens but through a different minting contract.
                    </div>
                    <div>
                      {[
                        {k:"pXEN balance",   v:parseInt(xenBal).toLocaleString(),         c:C.pink},
                        {k:"Your pXENTs",    v:nativeXenfts.length,                       c:C.pink},
                        {k:"Ready",          v:nativeXenfts.filter(x=>x.matured).length,  c:C.green},
                      ].map(r=>(
                        <div key={r.k} style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:10}}>
                          <span style={{color:"rgba(255,255,255,0.28)"}}>{r.k}</span>
                          <span style={{color:r.c,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </GlowCard>

                {/* Transaction logs (shared with XENFT tab) */}
                {xenftLogs.length>0&&(
                  <GlowCard color={C.green} style={{padding:"14px 16px",marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                      <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.green}77`}}>▶ TRANSACTION LOGS ({xenftLogs.length})</div>
                      <NeonBtn color={C.pink} onClick={()=>setXenftLogs([])} small>Clear</NeonBtn>
                    </div>
                    <div style={{maxHeight:250,overflowY:"auto",background:"rgba(0,0,0,0.4)",border:"1px solid rgba(0,255,136,0.08)",padding:"8px 10px",fontFamily:"'Share Tech Mono',monospace",fontSize:10,lineHeight:1.6}}>
                      {xenftLogs.map(log=>{
                        const col = log.type==="success"?C.green : log.type==="error"?C.pink : log.type==="warning"?C.amber : log.type==="pending"?C.cyan : "rgba(255,255,255,0.5)";
                        const prefix = log.type==="success"?"✓" : log.type==="error"?"✗" : log.type==="warning"?"⚠" : log.type==="pending"?"⏳" : "›";
                        return(
                          <div key={log.id} style={{marginBottom:4,display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                            <span style={{color:"rgba(255,255,255,0.25)",flexShrink:0,fontSize:9}}>{log.time}</span>
                            <span style={{color:col,flexShrink:0}}>{prefix}</span>
                            <span style={{color:col,flex:1,wordBreak:"break-word",minWidth:0}}>{log.msg}</span>
                            {log.hash&&(
                              <a href={`https://scan.pulsechain.com/tx/${log.hash}`} target="_blank" rel="noopener noreferrer"
                                style={{color:`${C.cyan}aa`,fontSize:9,textDecoration:"none",flexShrink:0}}>
                                {short(log.hash)} ↗
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </GlowCard>
                )}

                {/* Difference callout */}
                <GlowCard color={C.amber} style={{padding:"12px 16px",marginBottom:12}}>
                  <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",lineHeight:1.7}}>
                    <span style={{color:C.amber,fontWeight:700}}>ℹ Note:</span> Both XENT and pXENT reward the same <span style={{color:C.cyan}}>pXEN token</span>. The difference is just which XENFT minting contract you use. pXENTs appear on <span style={{color:C.pink}}>xen.network/pulse-chain</span>, XENTs appear on <span style={{color:C.purple}}>og.xen.network</span>.
                  </div>
                </GlowCard>

                {nativeLoading&&<div style={{textAlign:"center",padding:20,fontSize:10,color:`${C.pink}66`}}>Loading native XENFTs...</div>}

                {!nativeLoading&&nativeXenfts.length===0&&(
                  <GlowCard color={C.pink} style={{padding:28,textAlign:"center"}}>
                    <div style={{fontSize:28,marginBottom:10}}>🌱</div>
                    <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,color:C.pink,marginBottom:6}}>No pXENTs yet</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.3)",marginBottom:16}}>Mint your first pXENT on the xen.network contract — rewards pXEN just like XENT.</div>
                    <NeonBtn color={C.pink} onClick={()=>setNativeModal(true)} full>🌱 Mint First pXENT</NeonBtn>
                  </GlowCard>
                )}

                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {nativeXenfts.map(nft=>{
                    const nowSec=Math.floor(Date.now()/1000);
                    const trulyMatured=nft.maturityTs>0&&nowSec>=nft.maturityTs;
                    const isRedeemed=!!nft.redeemed;
                    const state=isRedeemed?"REDEEMED":trulyMatured?"READY":"MATURING";
                    const stateColor={REDEEMED:"rgba(255,255,255,0.35)",READY:C.green,MATURING:C.cyan}[state];
                    return(
                    <GlowCard key={nft.tokenId} color={stateColor} style={{padding:"16px 16px",opacity:isRedeemed?0.55:1}}>
                      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                            <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:stateColor}}>pXENT #{nft.tokenId}</div>
                            <span style={{fontSize:8,padding:"2px 7px",color:stateColor,border:`1px solid ${stateColor}44`,background:`${stateColor}0e`}}>
                              {state==="REDEEMED"?"✓ REDEEMED":state}
                            </span>
                          </div>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                            {[
                              {k:"VMUs",      v:nft.vmus||"?"},
                              {k:"Term",      v:nft.term&&nft.term!=="?"?`${nft.term}d`:"—"},
                              {k:"Matures On",v:nft.maturityDate||"—"},
                              {k:"Est. pXEN",  v:nft.estXen?fmtN(nft.estXen):"—"},
                            ].map(r=>(
                              <div key={r.k} style={{fontSize:10}}>
                                <span style={{color:"rgba(255,255,255,0.28)"}}>{r.k}: </span>
                                <span style={{color:"rgba(255,255,255,0.7)",fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v}</span>
                              </div>
                            ))}
                          </div>
                          {state==="MATURING"&&nft.maturityTs>0&&(
                            <div style={{marginTop:10,padding:"8px 12px",background:`${C.cyan}08`,border:`1px solid ${C.cyan}22`}}>
                              <div style={{fontSize:8,letterSpacing:"0.15em",color:`${C.cyan}66`,marginBottom:4}}>TIME UNTIL MATURITY</div>
                              <div style={{fontSize:14,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>
                                <Countdown targetDate={new Date(nft.maturityTs*1000)}/>
                              </div>
                            </div>
                          )}
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                          {state==="READY"&&(
                            <NeonBtn color={C.green} onClick={()=>handleClaimNative(nft.tokenId)} disabled={!!txPending}>
                              ⛏ Claim pXEN
                            </NeonBtn>
                          )}
                          <NeonBtn color={C.pink} onClick={()=>window.open(`https://xen.network/pulse-chain/xenft/torrent`,"_blank")} small>
                            View ↗
                          </NeonBtn>
                        </div>
                      </div>
                    </GlowCard>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ══ AUTO-CLAIM ══ */}
            {tab==="auto-claim"&&(
              <div className="fade-up">
                {failCount>=3&&(
                  <GlowCard color={C.pink} style={{padding:"14px 16px",marginBottom:12}}>
                    <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.pink}66`,marginBottom:8}}>⚠ FAILURE ALERT</div>
                    <div style={{fontSize:11,color:C.pink,marginBottom:6}}>Auto-claim has failed {failCount} times</div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",marginBottom:12}}>{lastError}</div>
                    <div style={{display:"flex",gap:8}}>
                      <NeonBtn color={C.amber} onClick={runAutoCheck} full>↻ Retry Now</NeonBtn>
                      <NeonBtn color={C.pink} onClick={()=>{setFailCount(0);setLastError(null);}} full>Dismiss</NeonBtn>
                    </div>
                  </GlowCard>
                )}

                <GlowCard color={autoOn?C.green:C.cyan} style={{padding:"20px 16px",marginBottom:12}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
                    <div style={{width:12,height:12,borderRadius:"50%",background:autoOn?C.green:"rgba(255,255,255,0.1)",boxShadow:autoOn?`0 0 12px ${C.green}`:undefined,...(autoOn?{animation:"blink 1.5s ease infinite"}:{})}}/>
                    <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,color:autoOn?C.green:"rgba(255,255,255,0.4)"}}>
                      {autoOn?`RUNNING — every ${checkMins} min`:"AUTO-CLAIM INACTIVE"}
                    </div>
                  </div>
                  {lastCheck&&<div style={{fontSize:10,color:"rgba(255,255,255,0.28)",marginBottom:6}}>Last check: {lastCheck.toLocaleTimeString()}</div>}
                  {cd&&<div style={{fontSize:10,color:"rgba(255,255,255,0.28)",marginBottom:16}}>Ready now: <span style={{color:cd.maturedCount>0?C.green:C.cyan}}>{cd.maturedCount} wallets</span></div>}
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    {!autoOn
                      ?<NeonBtn color={C.green} onClick={demoMode?()=>showToast("Demo mode",C.purple):startAuto} full>🤖 Start Auto-Claim</NeonBtn>
                      :<NeonBtn color={C.pink}  onClick={stopAuto}  full>⏹ Stop Auto-Claim</NeonBtn>}
                    <NeonBtn color={C.cyan} onClick={demoMode?()=>{}:loadData} disabled={loading} full>↻ Check Now</NeonBtn>
                  </div>
                </GlowCard>

                <GlowCard color={C.amber} style={{padding:"18px 16px",marginBottom:12}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.amber}66`,marginBottom:16}}>NOTIFICATIONS</div>
                  <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",marginBottom:12,lineHeight:1.6}}>
                    Get browser alerts when claims fire, fail, or wallets near expiry.
                  </div>
                  {notifPerms==="granted"
                    ?<div style={{fontSize:10,color:C.green}}>✓ Notifications enabled</div>
                    :<NeonBtn color={C.amber} onClick={requestNotifs} full>🔔 Enable Notifications</NeonBtn>}
                </GlowCard>

                {/* ── Flow explanation ── */}
                <GlowCard color={C.purple} style={{padding:"18px 16px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.purple}55`,marginBottom:14}}>WHAT HAPPENS</div>
                  {[
                    {icon:"⏱",t:"Checks every "+checkMins+" min",d:"Polls maturedCount() on PulseChain"},
                    {icon:"🔍",t:"Detects matured wallets",d:"Only fires when maturedCount > 0"},
                    {icon:"⚡",t:"Atomic claim+stake+restart",d:"One tx via MetaMask — no manual steps"},
                    {icon:"🔔",t:"Notifies you",d:"Browser push when claims succeed or fail"},
                    {icon:"⚠",t:"Failure alerts",d:"Banner + notification after 3 consecutive failures"},
                  ].map(r=>(
                    <div key={r.t} style={{display:"flex",gap:12,marginBottom:12,alignItems:"flex-start"}}>
                      <span style={{fontSize:14,flexShrink:0}}>{r.icon}</span>
                      <div>
                        <div style={{fontSize:11,color:"rgba(255,255,255,0.65)",marginBottom:2}}>{r.t}</div>
                        <div style={{fontSize:10,color:"rgba(255,255,255,0.28)"}}>{r.d}</div>
                      </div>
                    </div>
                  ))}
                </GlowCard>
              </div>
            )}

            {/* ══ ANALYTICS ══ */}
            {tab==="analytics"&&(
              <div className="fade-up">
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
                  <StatCard label="Total pXEN Earned" value={fmtN(analytics.totalEarned)} sub="all time" icon="💎" color={C.cyan}/>
                  <StatCard label="Total Claims"      value={analytics.claimCount}         sub="sessions" icon="⛏" color={C.purple}/>
                  <StatCard label="Gas Spent"         value={`${analytics.totalGasPls} PLS`} sub="all time" icon="⛽" color={C.amber}/>
                  <StatCard label="Est. Daily Yield"  value={cd?fmtN(Math.floor(cd.totalProxies*800)):"—"} sub="pXEN/day" icon="📈" color={C.green}/>
                </div>

                <GlowCard color={C.cyan} style={{padding:"16px 14px",marginBottom:14}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.cyan}55`,marginBottom:14}}>pXEN EARNED PER CLAIM</div>
                  {analytics.chartData.length===0
                    ?<div style={{textAlign:"center",padding:24,fontSize:10,color:"rgba(255,255,255,0.2)"}}>No claims yet this session</div>
                    :<ResponsiveContainer width="100%" height={160}>
                      <AreaChart data={analytics.chartData} margin={{top:4,right:4,left:-20,bottom:0}}>
                        <defs>
                          <linearGradient id="xenGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={C.cyan} stopOpacity={0.3}/>
                            <stop offset="95%" stopColor={C.cyan} stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="day" tick={{fill:"rgba(255,255,255,0.25)",fontSize:9}} axisLine={false} tickLine={false}/>
                        <YAxis tick={{fill:"rgba(255,255,255,0.25)",fontSize:9}} axisLine={false} tickLine={false}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Area type="monotone" dataKey="xen" name="pXEN" stroke={C.cyan} strokeWidth={2} fill="url(#xenGrad)"/>
                      </AreaChart>
                    </ResponsiveContainer>}
                </GlowCard>

                <GlowCard color={C.amber} style={{padding:"16px 14px",marginBottom:14}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.amber}55`,marginBottom:14}}>GAS SPENT PER CLAIM (PLS)</div>
                  {analytics.chartData.length===0
                    ?<div style={{textAlign:"center",padding:24,fontSize:10,color:"rgba(255,255,255,0.2)"}}>No claims yet</div>
                    :<ResponsiveContainer width="100%" height={120}>
                      <BarChart data={analytics.chartData} margin={{top:4,right:4,left:-20,bottom:0}}>
                        <XAxis dataKey="day" tick={{fill:"rgba(255,255,255,0.25)",fontSize:9}} axisLine={false} tickLine={false}/>
                        <YAxis tick={{fill:"rgba(255,255,255,0.25)",fontSize:9}} axisLine={false} tickLine={false}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Bar dataKey="gas" name="gas" fill={C.amber} fillOpacity={0.7} radius={[2,2,0,0]}/>
                      </BarChart>
                    </ResponsiveContainer>}
                </GlowCard>

                <GlowCard color={C.green} style={{padding:"16px 14px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.green}55`,marginBottom:14}}>YIELD ESTIMATE</div>
                  {[
                    {k:"Daily",    v:cd?fmtN(cd.totalProxies*800):"—",   c:C.cyan},
                    {k:"Weekly",   v:cd?fmtN(cd.totalProxies*5600):"—",  c:C.cyan},
                    {k:"Monthly",  v:cd?fmtN(cd.totalProxies*24000):"—", c:C.green},
                    {k:"Per proxy",v:"~800–1,200",                        c:C.amber},
                    {k:"Gas/claim",v:"~0.05–0.1 PLS",                     c:C.amber},
                  ].map(r=>(
                    <div key={r.k} style={{display:"flex",justifyContent:"space-between",marginBottom:10,fontSize:11}}>
                      <span style={{color:"rgba(255,255,255,0.3)"}}>{r.k}</span>
                      <span style={{color:r.c,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v} pXEN</span>
                    </div>
                  ))}
                  <div style={{marginTop:8,fontSize:9,color:"rgba(255,255,255,0.2)"}}>* estimates based on current rank and term</div>
                </GlowCard>
              </div>
            )}

            {/* ══ SETTINGS ══ */}
            {tab==="settings"&&(
              <div className="fade-up" style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Auto-claim config */}
                <GlowCard color={C.cyan} style={{padding:"18px 16px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.cyan}55`,marginBottom:16}}>AUTO-CLAIM SETTINGS</div>
                  {[
                    {label:`Check interval: ${checkMins} min`, min:1, max:60, value:checkMins, set:setCheckMins, color:C.cyan},
                    {label:`Restake %: ${restakePct}%`,        min:0, max:100,value:restakePct,set:setRestakePct,color:C.amber},
                    {label:`Mint term: ${mintTermDays} days`,  min:1, max:550,value:mintTermDays,set:setMintTermDays,color:C.purple},
                  ].map(s=>(
                    <div key={s.label} style={{marginBottom:16}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                        <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>{s.label}</span>
                      </div>
                      <input type="range" min={s.min} max={s.max} value={s.value}
                        onChange={e=>s.set(+e.target.value)}
                        style={{width:"100%",background:`linear-gradient(to right,${s.color}55 0%,${s.color}55 ${((s.value-s.min)/(s.max-s.min))*100}%,rgba(255,255,255,0.1) ${((s.value-s.min)/(s.max-s.min))*100}%)`}}/>
                    </div>
                  ))}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4}}>
                    <span style={{fontSize:10,color:"rgba(255,255,255,0.35)"}}>Auto-restart after claim</span>
                    <NeonBtn color={autoRestart?C.green:C.pink} onClick={()=>setAutoRestart(v=>!v)} small>
                      {autoRestart?"ON":"OFF"}
                    </NeonBtn>
                  </div>
                </GlowCard>

                {/* Notifications */}
                <GlowCard color={C.amber} style={{padding:"18px 16px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.amber}55`,marginBottom:14}}>NOTIFICATIONS</div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontSize:10,color:"rgba(255,255,255,0.35)"}}>Status: <span style={{color:notifPerms==="granted"?C.green:C.pink}}>{notifPerms}</span></span>
                    {notifPerms!=="granted"&&<NeonBtn color={C.amber} onClick={requestNotifs}>🔔 Enable</NeonBtn>}
                  </div>
                </GlowCard>

                {/* Contract */}
                <GlowCard color={C.purple} style={{padding:"18px 16px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.purple}55`,marginBottom:14}}>CONTRACT INFO</div>
                  {[
                    {k:"Network",  v:"PulseChain"},
                    {k:"Chain ID", v:"369"},
                    {k:"Manager",  v:demoMode?"0x8a7F...2a2a":short(managerAddr)},
                    {k:"Owner",    v:cd?short(cd.owner):"—"},
                    {k:"XEN",      v:short(XEN_ADDRESS)},
                    {k:"Wallet",   v:account?short(account):"—"},
                  ].map(r=>(
                    <div key={r.k} style={{display:"flex",justifyContent:"space-between",marginBottom:10,fontSize:11}}>
                      <span style={{color:"rgba(255,255,255,0.28)"}}>{r.k}</span>
                      <span style={{color:"rgba(255,255,255,0.55)"}}>{r.v}</span>
                    </div>
                  ))}
                </GlowCard>

                {/* Quick contract switcher */}
                <GlowCard color={C.cyan} style={{padding:"18px 16px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.cyan}88`,marginBottom:10}}>QUICK SWITCH</div>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {KNOWN_CONTRACTS.map(k=>{
                      const active = managerAddr.toLowerCase()===k.address.toLowerCase();
                      return (
                        <NeonBtn key={k.address} color={active?C.green:C.cyan}
                          onClick={()=>!active&&switchManager(k.address)} full>
                          {active?"● ":""}{k.label} — {short(k.address)}
                        </NeonBtn>
                      );
                    })}
                  </div>
                </GlowCard>

                {/* Danger zone */}
                <GlowCard color={C.pink} style={{padding:"18px 16px"}}>
                  <div style={{fontSize:9,letterSpacing:"0.18em",color:`${C.pink}55`,marginBottom:14}}>DANGER ZONE</div>
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    <NeonBtn color={C.amber} onClick={()=>{setManagerAddr("");setCd(null);setProxies([]);}} full>Custom Contract...</NeonBtn>
                    <NeonBtn color={C.pink}  onClick={()=>{setAccount(null);setManagerAddr("");setCd(null);stopAuto();setProxies([]);}} full>Disconnect Wallet</NeonBtn>
                  </div>
                </GlowCard>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── NATIVE XENFT MINT MODAL ── */}
      {nativeModal&&(
        <div style={{position:"fixed",inset:0,zIndex:1001,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:420,background:"rgba(0,5,20,0.98)",border:`1px solid ${C.pink}44`,boxShadow:`0 0 60px ${C.pink}22`}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.pink}22`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:C.pink,textShadow:`0 0 16px ${C.pink}`}}>🌱 Mint pXENTs</div>
              <NeonBtn color={C.pink} onClick={()=>{if(!nativeMinting)setNativeModal(false);}} small>✕</NeonBtn>
            </div>

            <div style={{padding:20}}>
              <div style={{padding:"10px 14px",background:`${C.pink}08`,border:`1px solid ${C.pink}22`,marginBottom:20,fontSize:10,color:"rgba(255,255,255,0.4)",lineHeight:1.7}}>
                Minting on the <span style={{color:C.pink}}>pXENT contract</span> supported by xen.network/pulse-chain. Rewards are still in <span style={{color:C.cyan}}>pXEN</span> — same as XENT, just a different minting path.
              </div>

              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Number of XENFTs to mint</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.pink}}>{nativeCount}</span>
                </div>
                <input type="range" min={1} max={20} value={nativeCount} onChange={e=>setNativeCount(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.pink}55 ${(nativeCount/20)*100}%,rgba(255,255,255,0.08) ${(nativeCount/20)*100}%)`}}/>
              </div>

              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>VMUs per XENFT</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.cyan}}>{nativeVmus}</span>
                </div>
                <input type="range" min={1} max={128} value={nativeVmus} onChange={e=>setNativeVmus(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.cyan}55 ${(nativeVmus/128)*100}%,rgba(255,255,255,0.08) ${(nativeVmus/128)*100}%)`}}/>
              </div>

              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Term</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.amber}}>{nativeTerm} days</span>
                </div>
                <input type="range" min={1} max={515} value={nativeTerm} onChange={e=>setNativeTerm(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.amber}55 ${(nativeTerm/515)*100}%,rgba(255,255,255,0.08) ${(nativeTerm/515)*100}%)`}}/>
                <div style={{fontSize:9,color:"rgba(255,255,255,0.25)",marginTop:4,textAlign:"right"}}>Max safe term: ~515 days (grows over time)</div>
              </div>

              <div style={{padding:"12px 16px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",marginBottom:16}}>
                <div style={{fontSize:9,letterSpacing:"0.15em",color:"rgba(255,255,255,0.2)",marginBottom:12}}>SUMMARY</div>
                {[
                  {k:"Contract",    v:"pXENT (0xfEa13BF2...)",                                           c:C.pink},
                  {k:"XENFTs",      v:`${nativeCount}`,                                                  c:C.pink},
                  {k:"VMUs each",   v:`${nativeVmus}`,                                                   c:C.cyan},
                  {k:"Total VMUs",  v:`${nativeCount*nativeVmus}`,                                       c:C.cyan},
                  {k:"Term",        v:`${nativeTerm}d`,                                                  c:C.amber},
                  {k:"Matures",     v:new Date(Date.now()+nativeTerm*86400000).toLocaleDateString(),     c:"rgba(255,255,255,0.5)"},
                  {k:"Rewards in",  v:"pXEN (same as XENT)",                                             c:C.cyan},
                  {k:"PLS balance", v:`${plsBal} PLS`,                                                   c:C.green},
                ].map(r=>(
                  <div key={r.k} style={{display:"flex",justifyContent:"space-between",marginBottom:7,fontSize:10}}>
                    <span style={{color:"rgba(255,255,255,0.3)"}}>{r.k}</span>
                    <span style={{color:r.c,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v}</span>
                  </div>
                ))}
              </div>

              {nativeMinting&&(
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:10}}>
                    <span style={{color:C.pink}}>Minting progress</span>
                    <span style={{color:C.pink,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{nativeProgress}/{nativeCount}</span>
                  </div>
                  <div style={{height:4,background:"rgba(255,255,255,0.05)",borderRadius:2}}>
                    <div style={{height:"100%",width:`${(nativeProgress/nativeCount)*100}%`,background:`linear-gradient(90deg,${C.pink}66,${C.pink})`,borderRadius:2,boxShadow:`0 0 8px ${C.pink}55`,transition:"width 0.4s"}}/>
                  </div>
                </div>
              )}

              <NeonBtn color={C.pink} onClick={handleMintNative} disabled={nativeMinting||!!txPending} full>
                {nativeMinting?`⏳ Minting ${nativeProgress}/${nativeCount}...`:`🌱 Mint ${nativeCount} pXENT${nativeCount>1?"s":""}`}
              </NeonBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── XENFT MINT MODAL ── */}
      {xenftModal&&(
        <div style={{position:"fixed",inset:0,zIndex:1001,background:"rgba(0,0,0,0.85)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:420,background:"rgba(0,5,20,0.98)",border:`1px solid ${C.purple}44`,boxShadow:`0 0 60px ${C.purple}22`}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.purple}22`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:C.purple,textShadow:`0 0 16px ${C.purple}`}}>🖼 Mint Multiple XENFTs</div>
              <NeonBtn color={C.pink} onClick={()=>{if(!nftMinting)setXenftModal(false);}} small>✕</NeonBtn>
            </div>

            <div style={{padding:20}}>
              {/* Info */}
              <div style={{padding:"10px 14px",background:`${C.purple}08`,border:`1px solid ${C.purple}22`,marginBottom:20,fontSize:10,color:"rgba(255,255,255,0.4)",lineHeight:1.7}}>
                Each XENFT = <span style={{color:C.cyan}}>one NFT</span> with multiple VMUs minting simultaneously. You can mint several XENFTs in a row — each fires a separate MetaMask transaction. XENFTs are <span style={{color:C.amber}}>tradeable</span> — sell before maturity if needed.
              </div>

              {/* Number of XENFTs */}
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Number of XENFTs to mint</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.purple}}>{nftCount}</span>
                </div>
                <input type="range" min={1} max={20} value={nftCount} onChange={e=>setNftCount(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.purple}55 ${(nftCount/20)*100}%,rgba(255,255,255,0.08) ${(nftCount/20)*100}%)`}}/>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:9,color:"rgba(255,255,255,0.18)"}}>
                  <span>1</span><span>5</span><span>10</span><span>15</span><span>20</span>
                </div>
              </div>

              {/* VMUs per XENFT */}
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>VMUs per XENFT</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.cyan}}>{nftVmus}</span>
                </div>
                <input type="range" min={1} max={128} value={nftVmus} onChange={e=>setNftVmus(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.cyan}55 ${(nftVmus/128)*100}%,rgba(255,255,255,0.08) ${(nftVmus/128)*100}%)`}}/>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:9,color:"rgba(255,255,255,0.18)"}}>
                  <span>1</span><span>32</span><span>64</span><span>96</span><span>128</span>
                </div>
              </div>

              {/* Term */}
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Mint term</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.amber}}>{nftTerm} days</span>
                </div>
                <input type="range" min={1} max={515} value={nftTerm} onChange={e=>setNftTerm(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.amber}55 ${(nftTerm/515)*100}%,rgba(255,255,255,0.08) ${(nftTerm/515)*100}%)`}}/>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:9,color:"rgba(255,255,255,0.18)"}}>
                  <span>1d</span><span>100d</span><span>200d</span><span>400d</span><span>515d</span>
                </div>
                <div style={{fontSize:9,color:"rgba(255,255,255,0.25)",marginTop:4,textAlign:"right"}}>Max safe term: ~515 days</div>
              </div>

              {/* Summary */}
              <div style={{padding:"12px 16px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",marginBottom:16}}>
                <div style={{fontSize:9,letterSpacing:"0.15em",color:"rgba(255,255,255,0.2)",marginBottom:12}}>SUMMARY</div>
                {(()=>{
                  const gasPerNft = 300_000 + nftVmus * 500_000;
                  const totalGas = gasPerNft * nftCount;
                  const estPls = liveGasPrice ? (Number(BigInt(totalGas) * liveGasPrice) / 1e18).toFixed(4) : `~${(totalGas * 0.000000001).toFixed(3)}`;
                  return [
                    {k:"XENFTs",       v:`${nftCount} NFTs`,                                          c:C.purple},
                    {k:"VMUs each",    v:`${nftVmus} VMUs`,                                           c:C.cyan},
                    {k:"Total VMUs",   v:`${nftCount*nftVmus} minting`,                               c:C.cyan},
                    {k:"Term",         v:`${nftTerm} days`,                                           c:C.amber},
                    {k:"Matures",      v:new Date(Date.now()+nftTerm*86400000).toLocaleDateString(),  c:"rgba(255,255,255,0.5)"},
                    {k:"Gas per NFT",  v:`~${(gasPerNft/1e6).toFixed(1)}M gas`,                       c:"rgba(255,255,255,0.4)"},
                    {k:"Est. gas",     v:`~${estPls} PLS`,                                            c:C.green},
                    {k:"PLS balance",  v:`${plsBal} PLS`,                                             c:C.green},
                  ].map(r=>(
                    <div key={r.k} style={{display:"flex",justifyContent:"space-between",marginBottom:7,fontSize:10}}>
                      <span style={{color:"rgba(255,255,255,0.3)"}}>{r.k}</span>
                      <span style={{color:r.c,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v}</span>
                    </div>
                  ));
                })()}
              </div>

              {/* Progress bar when minting */}
              {nftMinting&&(
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:10}}>
                    <span style={{color:C.purple}}>Minting progress</span>
                    <span style={{color:C.purple,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{nftProgress}/{nftCount}</span>
                  </div>
                  <div style={{height:4,background:"rgba(255,255,255,0.05)",borderRadius:2}}>
                    <div style={{height:"100%",width:`${(nftProgress/nftCount)*100}%`,background:`linear-gradient(90deg,${C.purple}66,${C.purple})`,borderRadius:2,boxShadow:`0 0 8px ${C.purple}55`,transition:"width 0.4s"}}/>
                  </div>
                  <div style={{fontSize:9,color:"rgba(255,255,255,0.3)",marginTop:4}}>Approve each transaction in MetaMask</div>
                </div>
              )}

              {/* Confirm */}
              <NeonBtn color={C.purple}
                onClick={demoMode?()=>showToast("Demo mode — connect wallet to mint",C.purple):handleMintXENFTs}
                disabled={nftMinting||!!txPending} full>
                {nftMinting?`⏳ Minting ${nftProgress}/${nftCount}...`:`🖼 Mint ${nftCount} XENFT${nftCount>1?"s":""} (${nftCount*nftVmus} total VMUs)`}
              </NeonBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── PROXY MINT MODAL ── */}
      {mintModal&&(
        <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.82)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{width:"100%",maxWidth:420,background:"rgba(0,5,20,0.98)",border:`1px solid ${C.cyan}44`,boxShadow:`0 0 60px ${C.cyan}22`}}>
            {/* Header */}
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.cyan}22`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontFamily:"'Rajdhani',sans-serif",fontSize:18,fontWeight:700,color:C.cyan,textShadow:`0 0 16px ${C.cyan}`}}>⬡ Start New Mint</div>
              <NeonBtn color={C.pink} onClick={()=>setMintModal(false)} small>✕</NeonBtn>
            </div>

            <div style={{padding:20}}>
              {/* Info box */}
              <div style={{padding:"10px 14px",background:`${C.cyan}08`,border:`1px solid ${C.cyan}22`,marginBottom:20,fontSize:10,color:"rgba(255,255,255,0.4)",lineHeight:1.7}}>
                Deploys proxy wallets and calls <span style={{color:C.cyan}}>claimRank()</span> on each. Wallets mint pXEN for the chosen term. Only gas in PLS is required — no other cost.
              </div>

              {/* Wallet count slider */}
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Number of wallets</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.cyan}}>{mintCount}</span>
                </div>
                <input type="range" min={1} max={500} value={mintCount} onChange={e=>setMintCount(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.cyan}55 ${(mintCount/500)*100}%,rgba(255,255,255,0.08) ${(mintCount/500)*100}%)`}}/>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:9,color:"rgba(255,255,255,0.18)"}}>
                  <span>1</span><span>125</span><span>250</span><span>375</span><span>500</span>
                </div>
              </div>

              {/* Mint term slider */}
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                  <span style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Mint term</span>
                  <span style={{fontFamily:"'Rajdhani',sans-serif",fontSize:16,fontWeight:700,color:C.amber}}>{mintTerm} days</span>
                </div>
                <input type="range" min={1} max={550} value={mintTerm} onChange={e=>setMintTerm(+e.target.value)}
                  style={{width:"100%",background:`linear-gradient(to right,${C.amber}55 ${(mintTerm/550)*100}%,rgba(255,255,255,0.08) ${(mintTerm/550)*100}%)`}}/>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:9,color:"rgba(255,255,255,0.18)"}}>
                  <span>1d</span><span>100d</span><span>200d</span><span>400d</span><span>550d</span>
                </div>
              </div>

              {/* Summary */}
              <div style={{padding:"12px 16px",background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",marginBottom:20}}>
                <div style={{fontSize:9,letterSpacing:"0.15em",color:"rgba(255,255,255,0.2)",marginBottom:12}}>SUMMARY</div>
                {(()=>{
                  // Real gas estimate: 8M gas limit × live gas price × mintCount txs
                  const GAS_LIMIT = 8_000_000n;
                  const estWei = liveGasPrice ? GAS_LIMIT * liveGasPrice * BigInt(Math.ceil(mintCount/5)) : null;
                  const estPls = estWei ? (Number(estWei)/1e18).toFixed(4) : "fetching...";
                  const sufficient = estWei ? parseFloat(plsBal) > Number(estWei)/1e18 : true;
                  return [
                    {k:"Wallets",     v:`${mintCount} proxies`,                                              c:C.cyan},
                    {k:"Term",        v:`${mintTerm} days`,                                                  c:C.amber},
                    {k:"Matures",     v:new Date(Date.now()+mintTerm*86400000).toLocaleDateString(),         c:"rgba(255,255,255,0.5)"},
                    {k:"Txs needed",  v:`${Math.ceil(mintCount/5)} approvals (5 wallets each)`,              c:"rgba(255,255,255,0.4)"},
                    {k:"Est. gas",    v:`~${estPls} PLS`,                                                    c:sufficient?C.green:C.pink},
                    {k:"PLS balance", v:`${plsBal} PLS`,                                                     c:sufficient?C.green:C.pink},
                  ].map(r=>(
                    <div key={r.k} style={{display:"flex",justifyContent:"space-between",marginBottom:8,fontSize:11}}>
                      <span style={{color:"rgba(255,255,255,0.3)"}}>{r.k}</span>
                      <span style={{color:r.c,fontFamily:"'Rajdhani',sans-serif",fontWeight:700}}>{r.v}</span>
                    </div>
                  ));
                })()}
              </div>

              {/* Low balance warning */}
              {!demoMode&&liveGasPrice&&parseFloat(plsBal)<Number(8_000_000n*liveGasPrice*BigInt(Math.ceil(mintCount/5)))/1e18&&(
                <div style={{marginBottom:12,padding:"8px 12px",background:"rgba(255,45,120,0.08)",border:`1px solid ${C.pink}33`,fontSize:10,color:C.pink}}>
                  ⚠ Low PLS — you may not have enough gas for {mintCount} wallets
                </div>
              )}

              {/* Confirm */}
              <NeonBtn color={C.green}
                onClick={demoMode?()=>showToast("Demo mode — connect wallet to mint",C.purple):handleStartMint}
                disabled={minting||!!txPending} full>
                {minting?`⏳ Deploying ${mintCount} wallets...`:`⬡ Start Minting ${mintCount} Wallets`}
              </NeonBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
