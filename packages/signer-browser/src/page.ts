/**
 * The page the wallet extension talks to.
 *
 * Self-contained on purpose: it uses only the wallet-standard events the
 * extension injects, so it needs no bundler, no CDN and no framework. It is
 * served once, on loopback, and it carries a single-use nonce — without that,
 * any other page on this machine could post a signature into a waiting signer.
 *
 * What the page does NOT do is decide anything. It renders what it was given,
 * refuses when the wallet does not hold the requested address, and hands back a
 * signature. Every rule about what may be signed lives in the runtime that asked.
 */
import type { SignerRequest } from './protocol.ts';

export interface PageInput {
  readonly request: SignerRequest;
  readonly nonce: string;
  /** Wallet-standard JSON for a TRANSACTION, so the wallet can render it. */
  readonly transactionJson?: string;
  readonly chain: string;
}

/**
 * A JS literal, safe to sit inside `<script>`.
 *
 * `JSON.stringify` alone is NOT enough: it happily emits `</script>` inside a
 * string, which closes the tag and hands the rest of the value to the parser as
 * markup. Escaping `<` as `\u003c` keeps the literal identical to JavaScript
 * while making it impossible to end the element early.
 */
const lit = (value: unknown): string =>
  JSON.stringify(value ?? null).replace(/</gu, '\\u003c');

/**
 * And a separate escape for markup, because `lit` is not one.
 *
 * The wallet address arrives from the caller. Interpolating it into the document
 * unescaped would let whoever writes a config file put a `<script>` on this page,
 * and this page is the thing that asks a wallet to sign.
 */
const text = (value: string): string =>
  value.replace(/[&<>"']/gu, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

export const buildPage = (input: PageInput): string => {
  const { request, nonce, transactionJson, chain } = input;
  const isTx = request.type === 'TRANSACTION';
  const title = isTx ? '簽署 WaterX 交易' : '簽署 WaterX 登入挑戰';
  const lede = isTx
    ? '交易由伺服器建立，你的錢包會顯示完整內容後才簽。這一步只簽名，不送鏈。'
    : '這個頁面只在本機，簽完就結束。私鑰全程留在你的錢包擴充功能裡。';

  return `<!doctype html><meta charset="utf-8"><title>${text(title)}</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans CJK TC",system-ui,sans-serif;max-width:36rem;margin:8vh auto;padding:0 1.5rem}
 h1{font-size:1.2rem;margin:0 0 .3rem}
 .m{color:#7a8791;font-size:.86rem}
 code{background:#8881;padding:.1rem .35rem;border-radius:3px;font-size:.82em;word-break:break-all}
 dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;font-size:.87rem;margin:1.1rem 0}
 dt{color:#7a8791}
 dd{margin:0}
 button{font:inherit;padding:.6rem 1.1rem;border:1px solid currentColor;border-radius:4px;background:none;cursor:pointer;margin:.3rem .3rem 0 0}
 button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
 #s{margin-top:1.2rem;padding:.8rem 1rem;border-left:3px solid #8a97a1;background:#8881;white-space:pre-wrap;font-size:.9rem}
 .ok{border-left-color:#1a7d55!important}.no{border-left-color:#c0392b!important}
</style>
<h1>${text(title)}</h1>
<p class="m">${text(lede)}</p>
<dl>
  <dt>錢包</dt><dd><code>${text(request.agentWallet)}</code></dd>
  <dt>種類</dt><dd><code>${text(request.type)}</code></dd>
</dl>
<div id="w"></div>
<div id="s">正在偵測錢包…</div>
<script type="module">
const NONCE=${lit(nonce)}, WANT=${lit(request.agentWallet)}, KIND=${lit(request.type)}, CHAIN=${lit(chain)};
const TXJSON=${lit(transactionJson)};
const MSG=KIND==='PERSONAL_MESSAGE'
  ? Uint8Array.from(atob(${lit(request.type === 'PERSONAL_MESSAGE' ? request.messageBase64 : '')}),c=>c.charCodeAt(0))
  : null;
const s=document.getElementById('s'), w=document.getElementById('w');
const say=(t,k)=>{s.textContent=t; s.className=k||''};
const post=(body)=>fetch('/done',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

const wallets=[]; const reg=x=>{ if(x&&!wallets.includes(x)) wallets.push(x) };
window.addEventListener('wallet-standard:register-wallet',e=>e.detail({register:reg}));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register:reg}}));
await new Promise(r=>setTimeout(r,350));

const NEED = KIND==='PERSONAL_MESSAGE' ? 'sui:signPersonalMessage' : 'sui:signTransaction';
const usable = wallets.filter(x=>x.features?.[NEED]);
if(!usable.length){
  say('找不到支援 '+NEED+' 的錢包擴充功能。安裝 Sui Wallet 或 Suiet 後重新整理這一頁。','no');
} else {
  say('請選擇持有這個地址的錢包：');
  for(const wallet of usable){
    const b=document.createElement('button');
    b.textContent=wallet.name;
    b.onclick=async()=>{
      try{
        say('連線中…');
        const r=await wallet.features['standard:connect'].connect();
        const accounts=(r?.accounts?.length ? r.accounts : wallet.accounts) ?? [];
        const norm=a=>a.replace(/^0x0*/,'').toLowerCase();
        const acct=accounts.find(a=>norm(a.address)===norm(WANT));
        // Refused here rather than signed with whatever is active: a signature
        // from the wrong account is not a smaller version of the right one.
        if(!acct){
          say('這個錢包沒有需要的地址。\\n需要：'+WANT+'\\n找到：'+(accounts.map(a=>a.address).join('\\n')||'（無）'),'no');
          return;
        }
        say(KIND==='TRANSACTION' ? '請在錢包中檢視並確認這筆交易…' : '請在錢包中確認簽章…');
        const out = KIND==='PERSONAL_MESSAGE'
          ? await wallet.features['sui:signPersonalMessage'].signPersonalMessage({message:MSG,account:acct})
          : await wallet.features['sui:signTransaction'].signTransaction({transaction:{toJSON:async()=>TXJSON},account:acct,chain:CHAIN});
        if(typeof out?.signature!=='string'||!out.signature){ say('錢包沒有回傳簽名。','no'); return }
        const res=await post({nonce:NONCE,signature:out.signature});
        say(res.ok ? '簽好了，可以關掉這個分頁。' : '回傳失敗：'+await res.text(), res.ok?'ok':'no');
      }catch(err){
        say('取消或失敗：'+(err?.message ?? String(err)),'no');
      }
    };
    w.appendChild(b);
  }
}
</script>`;
};
