const Tr=()=>{};var ri={};/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const _r={SDK_VERSION:"${JSCORE_VERSION}"};/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const ha=function(n,i){if(!n)throw Dr(i)},Dr=function(n){return new Error("Firebase Database ("+_r.SDK_VERSION+") INTERNAL ASSERT FAILED: "+n)};/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const vi=function(n){const i=[];let s=0;for(let c=0;c<n.length;c++){let g=n.charCodeAt(c);g<128?i[s++]=g:g<2048?(i[s++]=g>>6|192,i[s++]=g&63|128):(g&64512)===55296&&c+1<n.length&&(n.charCodeAt(c+1)&64512)===56320?(g=65536+((g&1023)<<10)+(n.charCodeAt(++c)&1023),i[s++]=g>>18|240,i[s++]=g>>12&63|128,i[s++]=g>>6&63|128,i[s++]=g&63|128):(i[s++]=g>>12|224,i[s++]=g>>6&63|128,i[s++]=g&63|128)}return i},Or=function(n){const i=[];let s=0,c=0;for(;s<n.length;){const g=n[s++];if(g<128)i[c++]=String.fromCharCode(g);else if(g>191&&g<224){const w=n[s++];i[c++]=String.fromCharCode((g&31)<<6|w&63)}else if(g>239&&g<365){const w=n[s++],v=n[s++],I=n[s++],C=((g&7)<<18|(w&63)<<12|(v&63)<<6|I&63)-65536;i[c++]=String.fromCharCode(55296+(C>>10)),i[c++]=String.fromCharCode(56320+(C&1023))}else{const w=n[s++],v=n[s++];i[c++]=String.fromCharCode((g&15)<<12|(w&63)<<6|v&63)}}return i.join("")},wi={byteToCharMap_:null,charToByteMap_:null,byteToCharMapWebSafe_:null,charToByteMapWebSafe_:null,ENCODED_VALS_BASE:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",get ENCODED_VALS(){return this.ENCODED_VALS_BASE+"+/="},get ENCODED_VALS_WEBSAFE(){return this.ENCODED_VALS_BASE+"-_."},HAS_NATIVE_SUPPORT:typeof atob=="function",encodeByteArray(n,i){if(!Array.isArray(n))throw Error("encodeByteArray takes an array as a parameter");this.init_();const s=i?this.byteToCharMapWebSafe_:this.byteToCharMap_,c=[];for(let g=0;g<n.length;g+=3){const w=n[g],v=g+1<n.length,I=v?n[g+1]:0,C=g+2<n.length,E=C?n[g+2]:0,F=w>>2,T=(w&3)<<4|I>>4;let S=(I&15)<<2|E>>6,k=E&63;C||(k=64,v||(S=64)),c.push(s[F],s[T],s[S],s[k])}return c.join("")},encodeString(n,i){return this.HAS_NATIVE_SUPPORT&&!i?btoa(n):this.encodeByteArray(vi(n),i)},decodeString(n,i){return this.HAS_NATIVE_SUPPORT&&!i?atob(n):Or(this.decodeStringToByteArray(n,i))},decodeStringToByteArray(n,i){this.init_();const s=i?this.charToByteMapWebSafe_:this.charToByteMap_,c=[];for(let g=0;g<n.length;){const w=s[n.charAt(g++)],I=g<n.length?s[n.charAt(g)]:0;++g;const E=g<n.length?s[n.charAt(g)]:64;++g;const T=g<n.length?s[n.charAt(g)]:64;if(++g,w==null||I==null||E==null||T==null)throw new Rr;const S=w<<2|I>>4;if(c.push(S),E!==64){const k=I<<4&240|E>>2;if(c.push(k),T!==64){const B=E<<6&192|T;c.push(B)}}}return c},init_(){if(!this.byteToCharMap_){this.byteToCharMap_={},this.charToByteMap_={},this.byteToCharMapWebSafe_={},this.charToByteMapWebSafe_={};for(let n=0;n<this.ENCODED_VALS.length;n++)this.byteToCharMap_[n]=this.ENCODED_VALS.charAt(n),this.charToByteMap_[this.byteToCharMap_[n]]=n,this.byteToCharMapWebSafe_[n]=this.ENCODED_VALS_WEBSAFE.charAt(n),this.charToByteMapWebSafe_[this.byteToCharMapWebSafe_[n]]=n,n>=this.ENCODED_VALS_BASE.length&&(this.charToByteMap_[this.ENCODED_VALS_WEBSAFE.charAt(n)]=n,this.charToByteMapWebSafe_[this.ENCODED_VALS.charAt(n)]=n)}}};class Rr extends Error{constructor(){super(...arguments),this.name="DecodeBase64StringError"}}const Mr=function(n){const i=vi(n);return wi.encodeByteArray(i,!0)},se=function(n){return Mr(n).replace(/\./g,"")},Ve=function(n){try{return wi.decodeString(n,!0)}catch(i){console.error("base64Decode failed: ",i)}return null};/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Br(){if(typeof self<"u")return self;if(typeof window<"u")return window;if(typeof global<"u")return global;throw new Error("Unable to locate global object.")}/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Pr=()=>Br().__FIREBASE_DEFAULTS__,kr=()=>{if(typeof process>"u"||typeof ri>"u")return;const n=ri.__FIREBASE_DEFAULTS__;if(n)return JSON.parse(n)},xr=()=>{if(typeof document>"u")return;let n;try{n=document.cookie.match(/__FIREBASE_DEFAULTS__=([^;]+)/)}catch{return}const i=n&&Ve(n[1]);return i&&JSON.parse(i)},he=()=>{try{return Tr()||Pr()||kr()||xr()}catch(n){console.info(`Unable to get __FIREBASE_DEFAULTS__ due to: ${n}`);return}},jr=n=>{var i,s;return(s=(i=he())==null?void 0:i.emulatorHosts)==null?void 0:s[n]},ca=n=>{const i=jr(n);if(!i)return;const s=i.lastIndexOf(":");if(s<=0||s+1===i.length)throw new Error(`Invalid host ${i} with no separate hostname and port!`);const c=parseInt(i.substring(s+1),10);return i[0]==="["?[i.substring(1,s-1),c]:[i.substring(0,s),c]},bi=()=>{var n;return(n=he())==null?void 0:n.config},la=n=>{var i;return(i=he())==null?void 0:i[`_${n}`]};/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Nr{constructor(){this.reject=()=>{},this.resolve=()=>{},this.promise=new Promise((i,s)=>{this.resolve=i,this.reject=s})}wrapCallback(i){return(s,c)=>{s?this.reject(s):this.resolve(c),typeof i=="function"&&(this.promise.catch(()=>{}),i.length===1?i(s):i(s,c))}}}/**
 * @license
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Lr(n){try{return(n.startsWith("http://")||n.startsWith("https://")?new URL(n).hostname:n).endsWith(".cloudworkstations.dev")}catch{return!1}}async function ua(n){return(await fetch(n,{credentials:"include"})).ok}/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function fa(n,i){if(n.uid)throw new Error('The "uid" field is no longer supported by mockUserToken. Please use "sub" instead for Firebase Auth User ID.');const s={alg:"none",type:"JWT"},c=i||"demo-project",g=n.iat||0,w=n.sub||n.user_id;if(!w)throw new Error("mockUserToken must contain 'sub' or 'user_id' field!");const v={iss:`https://securetoken.google.com/${c}`,aud:c,iat:g,exp:g+3600,auth_time:g,sub:w,user_id:w,firebase:{sign_in_provider:"custom",identities:{}},...n};return[se(JSON.stringify(s)),se(JSON.stringify(v)),""].join(".")}const Ht={};function Hr(){const n={prod:[],emulator:[]};for(const i of Object.keys(Ht))Ht[i]?n.emulator.push(i):n.prod.push(i);return n}function Fr(n){let i=document.getElementById(n),s=!1;return i||(i=document.createElement("div"),i.setAttribute("id",n),s=!0),{created:s,element:i}}let si=!1;function pa(n,i){if(typeof window>"u"||typeof document>"u"||!Lr(window.location.host)||Ht[n]===i||Ht[n]||si)return;Ht[n]=i;function s(S){return`__firebase__banner__${S}`}const c="__firebase__banner",w=Hr().prod.length>0;function v(){const S=document.getElementById(c);S&&S.remove()}function I(S){S.style.display="flex",S.style.background="#7faaf0",S.style.position="fixed",S.style.bottom="5px",S.style.left="5px",S.style.padding=".5em",S.style.borderRadius="5px",S.style.alignItems="center"}function C(S,k){S.setAttribute("width","24"),S.setAttribute("id",k),S.setAttribute("height","24"),S.setAttribute("viewBox","0 0 24 24"),S.setAttribute("fill","none"),S.style.marginLeft="-6px"}function E(){const S=document.createElement("span");return S.style.cursor="pointer",S.style.marginLeft="16px",S.style.fontSize="24px",S.innerHTML=" &times;",S.onclick=()=>{si=!0,v()},S}function F(S,k){S.setAttribute("id",k),S.innerText="Learn more",S.href="https://firebase.google.com/docs/studio/preview-apps#preview-backend",S.setAttribute("target","__blank"),S.style.paddingLeft="5px",S.style.textDecoration="underline"}function T(){const S=Fr(c),k=s("text"),B=document.getElementById(k)||document.createElement("span"),j=s("learnmore"),R=document.getElementById(j)||document.createElement("a"),G=s("preprendIcon"),W=document.getElementById(G)||document.createElementNS("http://www.w3.org/2000/svg","svg");if(S.created){const V=S.element;I(V),F(R,j);const J=E();C(W,G),V.append(W,B,R,J),document.body.appendChild(V)}w?(B.innerText="Preview backend disconnected.",W.innerHTML=`<g clip-path="url(#clip0_6013_33858)">
<path d="M4.8 17.6L12 5.6L19.2 17.6H4.8ZM6.91667 16.4H17.0833L12 7.93333L6.91667 16.4ZM12 15.6C12.1667 15.6 12.3056 15.5444 12.4167 15.4333C12.5389 15.3111 12.6 15.1667 12.6 15C12.6 14.8333 12.5389 14.6944 12.4167 14.5833C12.3056 14.4611 12.1667 14.4 12 14.4C11.8333 14.4 11.6889 14.4611 11.5667 14.5833C11.4556 14.6944 11.4 14.8333 11.4 15C11.4 15.1667 11.4556 15.3111 11.5667 15.4333C11.6889 15.5444 11.8333 15.6 12 15.6ZM11.4 13.6H12.6V10.4H11.4V13.6Z" fill="#212121"/>
</g>
<defs>
<clipPath id="clip0_6013_33858">
<rect width="24" height="24" fill="white"/>
</clipPath>
</defs>`):(W.innerHTML=`<g clip-path="url(#clip0_6083_34804)">
<path d="M11.4 15.2H12.6V11.2H11.4V15.2ZM12 10C12.1667 10 12.3056 9.94444 12.4167 9.83333C12.5389 9.71111 12.6 9.56667 12.6 9.4C12.6 9.23333 12.5389 9.09444 12.4167 8.98333C12.3056 8.86111 12.1667 8.8 12 8.8C11.8333 8.8 11.6889 8.86111 11.5667 8.98333C11.4556 9.09444 11.4 9.23333 11.4 9.4C11.4 9.56667 11.4556 9.71111 11.5667 9.83333C11.6889 9.94444 11.8333 10 12 10ZM12 18.4C11.1222 18.4 10.2944 18.2333 9.51667 17.9C8.73889 17.5667 8.05556 17.1111 7.46667 16.5333C6.88889 15.9444 6.43333 15.2611 6.1 14.4833C5.76667 13.7056 5.6 12.8778 5.6 12C5.6 11.1111 5.76667 10.2833 6.1 9.51667C6.43333 8.73889 6.88889 8.06111 7.46667 7.48333C8.05556 6.89444 8.73889 6.43333 9.51667 6.1C10.2944 5.76667 11.1222 5.6 12 5.6C12.8889 5.6 13.7167 5.76667 14.4833 6.1C15.2611 6.43333 15.9389 6.89444 16.5167 7.48333C17.1056 8.06111 17.5667 8.73889 17.9 9.51667C18.2333 10.2833 18.4 11.1111 18.4 12C18.4 12.8778 18.2333 13.7056 17.9 14.4833C17.5667 15.2611 17.1056 15.9444 16.5167 16.5333C15.9389 17.1111 15.2611 17.5667 14.4833 17.9C13.7167 18.2333 12.8889 18.4 12 18.4ZM12 17.2C13.4444 17.2 14.6722 16.6944 15.6833 15.6833C16.6944 14.6722 17.2 13.4444 17.2 12C17.2 10.5556 16.6944 9.32778 15.6833 8.31667C14.6722 7.30555 13.4444 6.8 12 6.8C10.5556 6.8 9.32778 7.30555 8.31667 8.31667C7.30556 9.32778 6.8 10.5556 6.8 12C6.8 13.4444 7.30556 14.6722 8.31667 15.6833C9.32778 16.6944 10.5556 17.2 12 17.2Z" fill="#212121"/>
</g>
<defs>
<clipPath id="clip0_6083_34804">
<rect width="24" height="24" fill="white"/>
</clipPath>
</defs>`,B.innerText="Preview backend running in this workspace."),B.setAttribute("id",k)}document.readyState==="loading"?window.addEventListener("DOMContentLoaded",T):T()}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Ei(){return typeof navigator<"u"&&typeof navigator.userAgent=="string"?navigator.userAgent:""}function ga(){return typeof window<"u"&&!!(window.cordova||window.phonegap||window.PhoneGap)&&/ios|iphone|ipod|ipad|android|blackberry|iemobile/i.test(Ei())}function Si(){var i;const n=(i=he())==null?void 0:i.forceEnvironment;if(n==="node")return!0;if(n==="browser")return!1;try{return Object.prototype.toString.call(global.process)==="[object process]"}catch{return!1}}function da(){return typeof navigator<"u"&&navigator.userAgent==="Cloudflare-Workers"}function ma(){const n=typeof chrome=="object"?chrome.runtime:typeof browser=="object"?browser.runtime:void 0;return typeof n=="object"&&n.id!==void 0}function ya(){return typeof navigator=="object"&&navigator.product==="ReactNative"}function va(){const n=Ei();return n.indexOf("MSIE ")>=0||n.indexOf("Trident/")>=0}function wa(){return!Si()&&!!navigator.userAgent&&navigator.userAgent.includes("Safari")&&!navigator.userAgent.includes("Chrome")}function ba(){return!Si()&&!!navigator.userAgent&&(navigator.userAgent.includes("Safari")||navigator.userAgent.includes("WebKit"))&&!navigator.userAgent.includes("Chrome")}function $r(){try{return typeof indexedDB=="object"}catch{return!1}}function Ur(){return new Promise((n,i)=>{try{let s=!0;const c="validate-browser-context-for-indexeddb-analytics-module",g=self.indexedDB.open(c);g.onsuccess=()=>{g.result.close(),s||self.indexedDB.deleteDatabase(c),n(!0)},g.onupgradeneeded=()=>{s=!1},g.onerror=()=>{var w;i(((w=g.error)==null?void 0:w.message)||"")}}catch(s){i(s)}})}function Ea(){return!(typeof navigator>"u"||!navigator.cookieEnabled)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Vr="FirebaseError";class yt extends Error{constructor(i,s,c){super(s),this.code=i,this.customData=c,this.name=Vr,Object.setPrototypeOf(this,yt.prototype),Error.captureStackTrace&&Error.captureStackTrace(this,Je.prototype.create)}}class Je{constructor(i,s,c){this.service=i,this.serviceName=s,this.errors=c}create(i,...s){const c=s[0]||{},g=`${this.service}/${i}`,w=this.errors[i],v=w?zr(w,c):"Error",I=`${this.serviceName}: ${v} (${g}).`;return new yt(g,I,c)}}function zr(n,i){return n.replace(Wr,(s,c)=>{const g=i[c];return g!=null?String(g):`<${c}?>`})}const Wr=/\{\$([^}]+)}/g;/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function oi(n){return JSON.parse(n)}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Xr=function(n){let i={},s={},c={},g="";try{const w=n.split(".");i=oi(Ve(w[0])||""),s=oi(Ve(w[1])||""),g=w[2],c=s.d||{},delete s.d}catch{}return{header:i,claims:s,data:c,signature:g}},Sa=function(n){const i=Xr(n).claims;return typeof i=="object"&&i.hasOwnProperty("iat")?i.iat:null};function Ia(n){for(const i in n)if(Object.prototype.hasOwnProperty.call(n,i))return!1;return!0}function ze(n,i){if(n===i)return!0;const s=Object.keys(n),c=Object.keys(i);for(const g of s){if(!c.includes(g))return!1;const w=n[g],v=i[g];if(ai(w)&&ai(v)){if(!ze(w,v))return!1}else if(w!==v)return!1}for(const g of c)if(!s.includes(g))return!1;return!0}function ai(n){return n!==null&&typeof n=="object"}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Ca(n){const i=[];for(const[s,c]of Object.entries(n))Array.isArray(c)?c.forEach(g=>{i.push(encodeURIComponent(s)+"="+encodeURIComponent(g))}):i.push(encodeURIComponent(s)+"="+encodeURIComponent(c));return i.length?"&"+i.join("&"):""}function Aa(n){const i={};return n.replace(/^\?/,"").split("&").forEach(c=>{if(c){const[g,w]=c.split("=");i[decodeURIComponent(g)]=decodeURIComponent(w)}}),i}function Ta(n){const i=n.indexOf("?");if(!i)return"";const s=n.indexOf("#",i);return n.substring(i,s>0?s:void 0)}function _a(n,i){const s=new qr(n,i);return s.subscribe.bind(s)}class qr{constructor(i,s){this.observers=[],this.unsubscribes=[],this.observerCount=0,this.task=Promise.resolve(),this.finalized=!1,this.onNoObservers=s,this.task.then(()=>{i(this)}).catch(c=>{this.error(c)})}next(i){this.forEachObserver(s=>{s.next(i)})}error(i){this.forEachObserver(s=>{s.error(i)}),this.close(i)}complete(){this.forEachObserver(i=>{i.complete()}),this.close()}subscribe(i,s,c){let g;if(i===void 0&&s===void 0&&c===void 0)throw new Error("Missing Observer.");Gr(i,["next","error","complete"])?g=i:g={next:i,error:s,complete:c},g.next===void 0&&(g.next=je),g.error===void 0&&(g.error=je),g.complete===void 0&&(g.complete=je);const w=this.unsubscribeOne.bind(this,this.observers.length);return this.finalized&&this.task.then(()=>{try{this.finalError?g.error(this.finalError):g.complete()}catch{}}),this.observers.push(g),w}unsubscribeOne(i){this.observers===void 0||this.observers[i]===void 0||(delete this.observers[i],this.observerCount-=1,this.observerCount===0&&this.onNoObservers!==void 0&&this.onNoObservers(this))}forEachObserver(i){if(!this.finalized)for(let s=0;s<this.observers.length;s++)this.sendOne(s,i)}sendOne(i,s){this.task.then(()=>{if(this.observers!==void 0&&this.observers[i]!==void 0)try{s(this.observers[i])}catch(c){typeof console<"u"&&console.error&&console.error(c)}})}close(i){this.finalized||(this.finalized=!0,i!==void 0&&(this.finalError=i),this.task.then(()=>{this.observers=void 0,this.onNoObservers=void 0}))}}function Gr(n,i){if(typeof n!="object"||n===null)return!1;for(const s of i)if(s in n&&typeof n[s]=="function")return!0;return!1}function je(){}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Kr=1e3,Jr=2,Yr=14400*1e3,Zr=.5;function Da(n,i=Kr,s=Jr){const c=i*Math.pow(s,n),g=Math.round(Zr*c*(Math.random()-.5)*2);return Math.min(Yr,c+g)}/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Oa(n){return n&&n._delegate?n._delegate:n}class Et{constructor(i,s,c){this.name=i,this.instanceFactory=s,this.type=c,this.multipleInstances=!1,this.serviceProps={},this.instantiationMode="LAZY",this.onInstanceCreated=null}setInstantiationMode(i){return this.instantiationMode=i,this}setMultipleInstances(i){return this.multipleInstances=i,this}setServiceProps(i){return this.serviceProps=i,this}setInstanceCreatedCallback(i){return this.onInstanceCreated=i,this}}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const ft="[DEFAULT]";/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Qr{constructor(i,s){this.name=i,this.container=s,this.component=null,this.instances=new Map,this.instancesDeferred=new Map,this.instancesOptions=new Map,this.onInitCallbacks=new Map}get(i){const s=this.normalizeInstanceIdentifier(i);if(!this.instancesDeferred.has(s)){const c=new Nr;if(this.instancesDeferred.set(s,c),this.isInitialized(s)||this.shouldAutoInitialize())try{const g=this.getOrInitializeService({instanceIdentifier:s});g&&c.resolve(g)}catch{}}return this.instancesDeferred.get(s).promise}getImmediate(i){const s=this.normalizeInstanceIdentifier(i==null?void 0:i.identifier),c=(i==null?void 0:i.optional)??!1;if(this.isInitialized(s)||this.shouldAutoInitialize())try{return this.getOrInitializeService({instanceIdentifier:s})}catch(g){if(c)return null;throw g}else{if(c)return null;throw Error(`Service ${this.name} is not available`)}}getComponent(){return this.component}setComponent(i){if(i.name!==this.name)throw Error(`Mismatching Component ${i.name} for Provider ${this.name}.`);if(this.component)throw Error(`Component for ${this.name} has already been provided`);if(this.component=i,!!this.shouldAutoInitialize()){if(es(i))try{this.getOrInitializeService({instanceIdentifier:ft})}catch{}for(const[s,c]of this.instancesDeferred.entries()){const g=this.normalizeInstanceIdentifier(s);try{const w=this.getOrInitializeService({instanceIdentifier:g});c.resolve(w)}catch{}}}}clearInstance(i=ft){this.instancesDeferred.delete(i),this.instancesOptions.delete(i),this.instances.delete(i)}async delete(){const i=Array.from(this.instances.values());await Promise.all([...i.filter(s=>"INTERNAL"in s).map(s=>s.INTERNAL.delete()),...i.filter(s=>"_delete"in s).map(s=>s._delete())])}isComponentSet(){return this.component!=null}isInitialized(i=ft){return this.instances.has(i)}getOptions(i=ft){return this.instancesOptions.get(i)||{}}initialize(i={}){const{options:s={}}=i,c=this.normalizeInstanceIdentifier(i.instanceIdentifier);if(this.isInitialized(c))throw Error(`${this.name}(${c}) has already been initialized`);if(!this.isComponentSet())throw Error(`Component ${this.name} has not been registered yet`);const g=this.getOrInitializeService({instanceIdentifier:c,options:s});for(const[w,v]of this.instancesDeferred.entries()){const I=this.normalizeInstanceIdentifier(w);c===I&&v.resolve(g)}return g}onInit(i,s){const c=this.normalizeInstanceIdentifier(s),g=this.onInitCallbacks.get(c)??new Set;g.add(i),this.onInitCallbacks.set(c,g);const w=this.instances.get(c);return w&&i(w,c),()=>{g.delete(i)}}invokeOnInitCallbacks(i,s){const c=this.onInitCallbacks.get(s);if(c)for(const g of c)try{g(i,s)}catch{}}getOrInitializeService({instanceIdentifier:i,options:s={}}){let c=this.instances.get(i);if(!c&&this.component&&(c=this.component.instanceFactory(this.container,{instanceIdentifier:ts(i),options:s}),this.instances.set(i,c),this.instancesOptions.set(i,s),this.invokeOnInitCallbacks(c,i),this.component.onInstanceCreated))try{this.component.onInstanceCreated(this.container,i,c)}catch{}return c||null}normalizeInstanceIdentifier(i=ft){return this.component?this.component.multipleInstances?i:ft:i}shouldAutoInitialize(){return!!this.component&&this.component.instantiationMode!=="EXPLICIT"}}function ts(n){return n===ft?void 0:n}function es(n){return n.instantiationMode==="EAGER"}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class ns{constructor(i){this.name=i,this.providers=new Map}addComponent(i){const s=this.getProvider(i.name);if(s.isComponentSet())throw new Error(`Component ${i.name} has already been registered with ${this.name}`);s.setComponent(i)}addOrOverwriteComponent(i){this.getProvider(i.name).isComponentSet()&&this.providers.delete(i.name),this.addComponent(i)}getProvider(i){if(this.providers.has(i))return this.providers.get(i);const s=new Qr(i,this);return this.providers.set(i,s),s}getProviders(){return Array.from(this.providers.values())}}/**
 * @license
 * Copyright 2017 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */var O;(function(n){n[n.DEBUG=0]="DEBUG",n[n.VERBOSE=1]="VERBOSE",n[n.INFO=2]="INFO",n[n.WARN=3]="WARN",n[n.ERROR=4]="ERROR",n[n.SILENT=5]="SILENT"})(O||(O={}));const is={debug:O.DEBUG,verbose:O.VERBOSE,info:O.INFO,warn:O.WARN,error:O.ERROR,silent:O.SILENT},rs=O.INFO,ss={[O.DEBUG]:"log",[O.VERBOSE]:"log",[O.INFO]:"info",[O.WARN]:"warn",[O.ERROR]:"error"},os=(n,i,...s)=>{if(i<n.logLevel)return;const c=new Date().toISOString(),g=ss[i];if(g)console[g](`[${c}]  ${n.name}:`,...s);else throw new Error(`Attempted to log a message with an invalid logType (value: ${i})`)};class as{constructor(i){this.name=i,this._logLevel=rs,this._logHandler=os,this._userLogHandler=null}get logLevel(){return this._logLevel}set logLevel(i){if(!(i in O))throw new TypeError(`Invalid value "${i}" assigned to \`logLevel\``);this._logLevel=i}setLogLevel(i){this._logLevel=typeof i=="string"?is[i]:i}get logHandler(){return this._logHandler}set logHandler(i){if(typeof i!="function")throw new TypeError("Value assigned to `logHandler` must be a function");this._logHandler=i}get userLogHandler(){return this._userLogHandler}set userLogHandler(i){this._userLogHandler=i}debug(...i){this._userLogHandler&&this._userLogHandler(this,O.DEBUG,...i),this._logHandler(this,O.DEBUG,...i)}log(...i){this._userLogHandler&&this._userLogHandler(this,O.VERBOSE,...i),this._logHandler(this,O.VERBOSE,...i)}info(...i){this._userLogHandler&&this._userLogHandler(this,O.INFO,...i),this._logHandler(this,O.INFO,...i)}warn(...i){this._userLogHandler&&this._userLogHandler(this,O.WARN,...i),this._logHandler(this,O.WARN,...i)}error(...i){this._userLogHandler&&this._userLogHandler(this,O.ERROR,...i),this._logHandler(this,O.ERROR,...i)}}const hs=(n,i)=>i.some(s=>n instanceof s);let hi,ci;function cs(){return hi||(hi=[IDBDatabase,IDBObjectStore,IDBIndex,IDBCursor,IDBTransaction])}function ls(){return ci||(ci=[IDBCursor.prototype.advance,IDBCursor.prototype.continue,IDBCursor.prototype.continuePrimaryKey])}const Ii=new WeakMap,We=new WeakMap,Ci=new WeakMap,Ne=new WeakMap,Ye=new WeakMap;function us(n){const i=new Promise((s,c)=>{const g=()=>{n.removeEventListener("success",w),n.removeEventListener("error",v)},w=()=>{s(rt(n.result)),g()},v=()=>{c(n.error),g()};n.addEventListener("success",w),n.addEventListener("error",v)});return i.then(s=>{s instanceof IDBCursor&&Ii.set(s,n)}).catch(()=>{}),Ye.set(i,n),i}function fs(n){if(We.has(n))return;const i=new Promise((s,c)=>{const g=()=>{n.removeEventListener("complete",w),n.removeEventListener("error",v),n.removeEventListener("abort",v)},w=()=>{s(),g()},v=()=>{c(n.error||new DOMException("AbortError","AbortError")),g()};n.addEventListener("complete",w),n.addEventListener("error",v),n.addEventListener("abort",v)});We.set(n,i)}let Xe={get(n,i,s){if(n instanceof IDBTransaction){if(i==="done")return We.get(n);if(i==="objectStoreNames")return n.objectStoreNames||Ci.get(n);if(i==="store")return s.objectStoreNames[1]?void 0:s.objectStore(s.objectStoreNames[0])}return rt(n[i])},set(n,i,s){return n[i]=s,!0},has(n,i){return n instanceof IDBTransaction&&(i==="done"||i==="store")?!0:i in n}};function ps(n){Xe=n(Xe)}function gs(n){return n===IDBDatabase.prototype.transaction&&!("objectStoreNames"in IDBTransaction.prototype)?function(i,...s){const c=n.call(Le(this),i,...s);return Ci.set(c,i.sort?i.sort():[i]),rt(c)}:ls().includes(n)?function(...i){return n.apply(Le(this),i),rt(Ii.get(this))}:function(...i){return rt(n.apply(Le(this),i))}}function ds(n){return typeof n=="function"?gs(n):(n instanceof IDBTransaction&&fs(n),hs(n,cs())?new Proxy(n,Xe):n)}function rt(n){if(n instanceof IDBRequest)return us(n);if(Ne.has(n))return Ne.get(n);const i=ds(n);return i!==n&&(Ne.set(n,i),Ye.set(i,n)),i}const Le=n=>Ye.get(n);function Ai(n,i,{blocked:s,upgrade:c,blocking:g,terminated:w}={}){const v=indexedDB.open(n,i),I=rt(v);return c&&v.addEventListener("upgradeneeded",C=>{c(rt(v.result),C.oldVersion,C.newVersion,rt(v.transaction),C)}),s&&v.addEventListener("blocked",C=>s(C.oldVersion,C.newVersion,C)),I.then(C=>{w&&C.addEventListener("close",()=>w()),g&&C.addEventListener("versionchange",E=>g(E.oldVersion,E.newVersion,E))}).catch(()=>{}),I}const ms=["get","getKey","getAll","getAllKeys","count"],ys=["put","add","delete","clear"],He=new Map;function li(n,i){if(!(n instanceof IDBDatabase&&!(i in n)&&typeof i=="string"))return;if(He.get(i))return He.get(i);const s=i.replace(/FromIndex$/,""),c=i!==s,g=ys.includes(s);if(!(s in(c?IDBIndex:IDBObjectStore).prototype)||!(g||ms.includes(s)))return;const w=async function(v,...I){const C=this.transaction(v,g?"readwrite":"readonly");let E=C.store;return c&&(E=E.index(I.shift())),(await Promise.all([E[s](...I),g&&C.done]))[0]};return He.set(i,w),w}ps(n=>({...n,get:(i,s,c)=>li(i,s)||n.get(i,s,c),has:(i,s)=>!!li(i,s)||n.has(i,s)}));/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class vs{constructor(i){this.container=i}getPlatformInfoString(){return this.container.getProviders().map(s=>{if(ws(s)){const c=s.getImmediate();return`${c.library}/${c.version}`}else return null}).filter(s=>s).join(" ")}}function ws(n){const i=n.getComponent();return(i==null?void 0:i.type)==="VERSION"}const qe="@firebase/app",ui="0.14.8";/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const K=new as("@firebase/app"),bs="@firebase/app-compat",Es="@firebase/analytics-compat",Ss="@firebase/analytics",Is="@firebase/app-check-compat",Cs="@firebase/app-check",As="@firebase/auth",Ts="@firebase/auth-compat",_s="@firebase/database",Ds="@firebase/data-connect",Os="@firebase/database-compat",Rs="@firebase/functions",Ms="@firebase/functions-compat",Bs="@firebase/installations",Ps="@firebase/installations-compat",ks="@firebase/messaging",xs="@firebase/messaging-compat",js="@firebase/performance",Ns="@firebase/performance-compat",Ls="@firebase/remote-config",Hs="@firebase/remote-config-compat",Fs="@firebase/storage",$s="@firebase/storage-compat",Us="@firebase/firestore",Vs="@firebase/ai",zs="@firebase/firestore-compat",Ws="firebase",Xs="12.9.0";/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ft="[DEFAULT]",qs={[qe]:"fire-core",[bs]:"fire-core-compat",[Ss]:"fire-analytics",[Es]:"fire-analytics-compat",[Cs]:"fire-app-check",[Is]:"fire-app-check-compat",[As]:"fire-auth",[Ts]:"fire-auth-compat",[_s]:"fire-rtdb",[Ds]:"fire-data-connect",[Os]:"fire-rtdb-compat",[Rs]:"fire-fn",[Ms]:"fire-fn-compat",[Bs]:"fire-iid",[Ps]:"fire-iid-compat",[ks]:"fire-fcm",[xs]:"fire-fcm-compat",[js]:"fire-perf",[Ns]:"fire-perf-compat",[Ls]:"fire-rc",[Hs]:"fire-rc-compat",[Fs]:"fire-gcs",[$s]:"fire-gcs-compat",[Us]:"fire-fst",[zs]:"fire-fst-compat",[Vs]:"fire-vertex","fire-js":"fire-js",[Ws]:"fire-js-all"};/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const $t=new Map,Ti=new Map,oe=new Map;function Ge(n,i){try{n.container.addComponent(i)}catch(s){K.debug(`Component ${i.name} failed to register with FirebaseApp ${n.name}`,s)}}function St(n){const i=n.name;if(oe.has(i))return K.debug(`There were multiple attempts to register component ${i}.`),!1;oe.set(i,n);for(const s of $t.values())Ge(s,n);for(const s of Ti.values())Ge(s,n);return!0}function ce(n,i){const s=n.container.getProvider("heartbeat").getImmediate({optional:!0});return s&&s.triggerHeartbeat(),n.container.getProvider(i)}function Gs(n,i,s=Ft){ce(n,i).clearInstance(s)}function Ks(n){return n==null?!1:n.settings!==void 0}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Js={"no-app":"No Firebase App '{$appName}' has been created - call initializeApp() first","bad-app-name":"Illegal App name: '{$appName}'","duplicate-app":"Firebase App named '{$appName}' already exists with different options or config","app-deleted":"Firebase App named '{$appName}' already deleted","server-app-deleted":"Firebase Server App has been deleted","no-options":"Need to provide options, when not being deployed to hosting via source.","invalid-app-argument":"firebase.{$appName}() takes either no argument or a Firebase App instance.","invalid-log-argument":"First argument to `onLog` must be null or a function.","idb-open":"Error thrown when opening IndexedDB. Original error: {$originalErrorMessage}.","idb-get":"Error thrown when reading from IndexedDB. Original error: {$originalErrorMessage}.","idb-set":"Error thrown when writing to IndexedDB. Original error: {$originalErrorMessage}.","idb-delete":"Error thrown when deleting from IndexedDB. Original error: {$originalErrorMessage}.","finalization-registry-not-supported":"FirebaseServerApp deleteOnDeref field defined but the JS runtime does not support FinalizationRegistry.","invalid-server-app-environment":"FirebaseServerApp is not for use in browser environments."},st=new Je("app","Firebase",Js);/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class Ys{constructor(i,s,c){this._isDeleted=!1,this._options={...i},this._config={...s},this._name=s.name,this._automaticDataCollectionEnabled=s.automaticDataCollectionEnabled,this._container=c,this.container.addComponent(new Et("app",()=>this,"PUBLIC"))}get automaticDataCollectionEnabled(){return this.checkDestroyed(),this._automaticDataCollectionEnabled}set automaticDataCollectionEnabled(i){this.checkDestroyed(),this._automaticDataCollectionEnabled=i}get name(){return this.checkDestroyed(),this._name}get options(){return this.checkDestroyed(),this._options}get config(){return this.checkDestroyed(),this._config}get container(){return this._container}get isDeleted(){return this._isDeleted}set isDeleted(i){this._isDeleted=i}checkDestroyed(){if(this.isDeleted)throw st.create("app-deleted",{appName:this._name})}}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Zs=Xs;function _i(n,i={}){let s=n;typeof i!="object"&&(i={name:i});const c={name:Ft,automaticDataCollectionEnabled:!0,...i},g=c.name;if(typeof g!="string"||!g)throw st.create("bad-app-name",{appName:String(g)});if(s||(s=bi()),!s)throw st.create("no-options");const w=$t.get(g);if(w){if(ze(s,w.options)&&ze(c,w.config))return w;throw st.create("duplicate-app",{appName:g})}const v=new ns(g);for(const C of oe.values())v.addComponent(C);const I=new Ys(s,c,v);return $t.set(g,I),I}function Qs(n=Ft){const i=$t.get(n);if(!i&&n===Ft&&bi())return _i();if(!i)throw st.create("no-app",{appName:n});return i}function gt(n,i,s){let c=qs[n]??n;s&&(c+=`-${s}`);const g=c.match(/\s|\//),w=i.match(/\s|\//);if(g||w){const v=[`Unable to register library "${c}" with version "${i}":`];g&&v.push(`library name "${c}" contains illegal characters (whitespace or "/")`),g&&w&&v.push("and"),w&&v.push(`version name "${i}" contains illegal characters (whitespace or "/")`),K.warn(v.join(" "));return}St(new Et(`${c}-version`,()=>({library:c,version:i}),"VERSION"))}/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const to="firebase-heartbeat-database",eo=1,Ut="firebase-heartbeat-store";let Fe=null;function Di(){return Fe||(Fe=Ai(to,eo,{upgrade:(n,i)=>{switch(i){case 0:try{n.createObjectStore(Ut)}catch(s){console.warn(s)}}}}).catch(n=>{throw st.create("idb-open",{originalErrorMessage:n.message})})),Fe}async function no(n){try{const s=(await Di()).transaction(Ut),c=await s.objectStore(Ut).get(Oi(n));return await s.done,c}catch(i){if(i instanceof yt)K.warn(i.message);else{const s=st.create("idb-get",{originalErrorMessage:i==null?void 0:i.message});K.warn(s.message)}}}async function fi(n,i){try{const c=(await Di()).transaction(Ut,"readwrite");await c.objectStore(Ut).put(i,Oi(n)),await c.done}catch(s){if(s instanceof yt)K.warn(s.message);else{const c=st.create("idb-set",{originalErrorMessage:s==null?void 0:s.message});K.warn(c.message)}}}function Oi(n){return`${n.name}!${n.options.appId}`}/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const io=1024,ro=30;class so{constructor(i){this.container=i,this._heartbeatsCache=null;const s=this.container.getProvider("app").getImmediate();this._storage=new ao(s),this._heartbeatsCachePromise=this._storage.read().then(c=>(this._heartbeatsCache=c,c))}async triggerHeartbeat(){var i,s;try{const g=this.container.getProvider("platform-logger").getImmediate().getPlatformInfoString(),w=pi();if(((i=this._heartbeatsCache)==null?void 0:i.heartbeats)==null&&(this._heartbeatsCache=await this._heartbeatsCachePromise,((s=this._heartbeatsCache)==null?void 0:s.heartbeats)==null)||this._heartbeatsCache.lastSentHeartbeatDate===w||this._heartbeatsCache.heartbeats.some(v=>v.date===w))return;if(this._heartbeatsCache.heartbeats.push({date:w,agent:g}),this._heartbeatsCache.heartbeats.length>ro){const v=ho(this._heartbeatsCache.heartbeats);this._heartbeatsCache.heartbeats.splice(v,1)}return this._storage.overwrite(this._heartbeatsCache)}catch(c){K.warn(c)}}async getHeartbeatsHeader(){var i;try{if(this._heartbeatsCache===null&&await this._heartbeatsCachePromise,((i=this._heartbeatsCache)==null?void 0:i.heartbeats)==null||this._heartbeatsCache.heartbeats.length===0)return"";const s=pi(),{heartbeatsToSend:c,unsentEntries:g}=oo(this._heartbeatsCache.heartbeats),w=se(JSON.stringify({version:2,heartbeats:c}));return this._heartbeatsCache.lastSentHeartbeatDate=s,g.length>0?(this._heartbeatsCache.heartbeats=g,await this._storage.overwrite(this._heartbeatsCache)):(this._heartbeatsCache.heartbeats=[],this._storage.overwrite(this._heartbeatsCache)),w}catch(s){return K.warn(s),""}}}function pi(){return new Date().toISOString().substring(0,10)}function oo(n,i=io){const s=[];let c=n.slice();for(const g of n){const w=s.find(v=>v.agent===g.agent);if(w){if(w.dates.push(g.date),gi(s)>i){w.dates.pop();break}}else if(s.push({agent:g.agent,dates:[g.date]}),gi(s)>i){s.pop();break}c=c.slice(1)}return{heartbeatsToSend:s,unsentEntries:c}}class ao{constructor(i){this.app=i,this._canUseIndexedDBPromise=this.runIndexedDBEnvironmentCheck()}async runIndexedDBEnvironmentCheck(){return $r()?Ur().then(()=>!0).catch(()=>!1):!1}async read(){if(await this._canUseIndexedDBPromise){const s=await no(this.app);return s!=null&&s.heartbeats?s:{heartbeats:[]}}else return{heartbeats:[]}}async overwrite(i){if(await this._canUseIndexedDBPromise){const c=await this.read();return fi(this.app,{lastSentHeartbeatDate:i.lastSentHeartbeatDate??c.lastSentHeartbeatDate,heartbeats:i.heartbeats})}else return}async add(i){if(await this._canUseIndexedDBPromise){const c=await this.read();return fi(this.app,{lastSentHeartbeatDate:i.lastSentHeartbeatDate??c.lastSentHeartbeatDate,heartbeats:[...c.heartbeats,...i.heartbeats]})}else return}}function gi(n){return se(JSON.stringify({version:2,heartbeats:n})).length}function ho(n){if(n.length===0)return-1;let i=0,s=n[0].date;for(let c=1;c<n.length;c++)n[c].date<s&&(s=n[c].date,i=c);return i}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function co(n){St(new Et("platform-logger",i=>new vs(i),"PRIVATE")),St(new Et("heartbeat",i=>new so(i),"PRIVATE")),gt(qe,ui,n),gt(qe,ui,"esm2020"),gt("fire-js","")}co("");var di=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{};/** @license
Copyright The Closure Library Authors.
SPDX-License-Identifier: Apache-2.0
*/var lo,uo;(function(){var n;/** @license

 Copyright The Closure Library Authors.
 SPDX-License-Identifier: Apache-2.0
*/function i(f,a){function l(){}l.prototype=a.prototype,f.F=a.prototype,f.prototype=new l,f.prototype.constructor=f,f.D=function(p,u,m){for(var h=Array(arguments.length-2),$=2;$<arguments.length;$++)h[$-2]=arguments[$];return a.prototype[u].apply(p,h)}}function s(){this.blockSize=-1}function c(){this.blockSize=-1,this.blockSize=64,this.g=Array(4),this.C=Array(this.blockSize),this.o=this.h=0,this.u()}i(c,s),c.prototype.u=function(){this.g[0]=1732584193,this.g[1]=4023233417,this.g[2]=2562383102,this.g[3]=271733878,this.o=this.h=0};function g(f,a,l){l||(l=0);const p=Array(16);if(typeof a=="string")for(var u=0;u<16;++u)p[u]=a.charCodeAt(l++)|a.charCodeAt(l++)<<8|a.charCodeAt(l++)<<16|a.charCodeAt(l++)<<24;else for(u=0;u<16;++u)p[u]=a[l++]|a[l++]<<8|a[l++]<<16|a[l++]<<24;a=f.g[0],l=f.g[1],u=f.g[2];let m=f.g[3],h;h=a+(m^l&(u^m))+p[0]+3614090360&4294967295,a=l+(h<<7&4294967295|h>>>25),h=m+(u^a&(l^u))+p[1]+3905402710&4294967295,m=a+(h<<12&4294967295|h>>>20),h=u+(l^m&(a^l))+p[2]+606105819&4294967295,u=m+(h<<17&4294967295|h>>>15),h=l+(a^u&(m^a))+p[3]+3250441966&4294967295,l=u+(h<<22&4294967295|h>>>10),h=a+(m^l&(u^m))+p[4]+4118548399&4294967295,a=l+(h<<7&4294967295|h>>>25),h=m+(u^a&(l^u))+p[5]+1200080426&4294967295,m=a+(h<<12&4294967295|h>>>20),h=u+(l^m&(a^l))+p[6]+2821735955&4294967295,u=m+(h<<17&4294967295|h>>>15),h=l+(a^u&(m^a))+p[7]+4249261313&4294967295,l=u+(h<<22&4294967295|h>>>10),h=a+(m^l&(u^m))+p[8]+1770035416&4294967295,a=l+(h<<7&4294967295|h>>>25),h=m+(u^a&(l^u))+p[9]+2336552879&4294967295,m=a+(h<<12&4294967295|h>>>20),h=u+(l^m&(a^l))+p[10]+4294925233&4294967295,u=m+(h<<17&4294967295|h>>>15),h=l+(a^u&(m^a))+p[11]+2304563134&4294967295,l=u+(h<<22&4294967295|h>>>10),h=a+(m^l&(u^m))+p[12]+1804603682&4294967295,a=l+(h<<7&4294967295|h>>>25),h=m+(u^a&(l^u))+p[13]+4254626195&4294967295,m=a+(h<<12&4294967295|h>>>20),h=u+(l^m&(a^l))+p[14]+2792965006&4294967295,u=m+(h<<17&4294967295|h>>>15),h=l+(a^u&(m^a))+p[15]+1236535329&4294967295,l=u+(h<<22&4294967295|h>>>10),h=a+(u^m&(l^u))+p[1]+4129170786&4294967295,a=l+(h<<5&4294967295|h>>>27),h=m+(l^u&(a^l))+p[6]+3225465664&4294967295,m=a+(h<<9&4294967295|h>>>23),h=u+(a^l&(m^a))+p[11]+643717713&4294967295,u=m+(h<<14&4294967295|h>>>18),h=l+(m^a&(u^m))+p[0]+3921069994&4294967295,l=u+(h<<20&4294967295|h>>>12),h=a+(u^m&(l^u))+p[5]+3593408605&4294967295,a=l+(h<<5&4294967295|h>>>27),h=m+(l^u&(a^l))+p[10]+38016083&4294967295,m=a+(h<<9&4294967295|h>>>23),h=u+(a^l&(m^a))+p[15]+3634488961&4294967295,u=m+(h<<14&4294967295|h>>>18),h=l+(m^a&(u^m))+p[4]+3889429448&4294967295,l=u+(h<<20&4294967295|h>>>12),h=a+(u^m&(l^u))+p[9]+568446438&4294967295,a=l+(h<<5&4294967295|h>>>27),h=m+(l^u&(a^l))+p[14]+3275163606&4294967295,m=a+(h<<9&4294967295|h>>>23),h=u+(a^l&(m^a))+p[3]+4107603335&4294967295,u=m+(h<<14&4294967295|h>>>18),h=l+(m^a&(u^m))+p[8]+1163531501&4294967295,l=u+(h<<20&4294967295|h>>>12),h=a+(u^m&(l^u))+p[13]+2850285829&4294967295,a=l+(h<<5&4294967295|h>>>27),h=m+(l^u&(a^l))+p[2]+4243563512&4294967295,m=a+(h<<9&4294967295|h>>>23),h=u+(a^l&(m^a))+p[7]+1735328473&4294967295,u=m+(h<<14&4294967295|h>>>18),h=l+(m^a&(u^m))+p[12]+2368359562&4294967295,l=u+(h<<20&4294967295|h>>>12),h=a+(l^u^m)+p[5]+4294588738&4294967295,a=l+(h<<4&4294967295|h>>>28),h=m+(a^l^u)+p[8]+2272392833&4294967295,m=a+(h<<11&4294967295|h>>>21),h=u+(m^a^l)+p[11]+1839030562&4294967295,u=m+(h<<16&4294967295|h>>>16),h=l+(u^m^a)+p[14]+4259657740&4294967295,l=u+(h<<23&4294967295|h>>>9),h=a+(l^u^m)+p[1]+2763975236&4294967295,a=l+(h<<4&4294967295|h>>>28),h=m+(a^l^u)+p[4]+1272893353&4294967295,m=a+(h<<11&4294967295|h>>>21),h=u+(m^a^l)+p[7]+4139469664&4294967295,u=m+(h<<16&4294967295|h>>>16),h=l+(u^m^a)+p[10]+3200236656&4294967295,l=u+(h<<23&4294967295|h>>>9),h=a+(l^u^m)+p[13]+681279174&4294967295,a=l+(h<<4&4294967295|h>>>28),h=m+(a^l^u)+p[0]+3936430074&4294967295,m=a+(h<<11&4294967295|h>>>21),h=u+(m^a^l)+p[3]+3572445317&4294967295,u=m+(h<<16&4294967295|h>>>16),h=l+(u^m^a)+p[6]+76029189&4294967295,l=u+(h<<23&4294967295|h>>>9),h=a+(l^u^m)+p[9]+3654602809&4294967295,a=l+(h<<4&4294967295|h>>>28),h=m+(a^l^u)+p[12]+3873151461&4294967295,m=a+(h<<11&4294967295|h>>>21),h=u+(m^a^l)+p[15]+530742520&4294967295,u=m+(h<<16&4294967295|h>>>16),h=l+(u^m^a)+p[2]+3299628645&4294967295,l=u+(h<<23&4294967295|h>>>9),h=a+(u^(l|~m))+p[0]+4096336452&4294967295,a=l+(h<<6&4294967295|h>>>26),h=m+(l^(a|~u))+p[7]+1126891415&4294967295,m=a+(h<<10&4294967295|h>>>22),h=u+(a^(m|~l))+p[14]+2878612391&4294967295,u=m+(h<<15&4294967295|h>>>17),h=l+(m^(u|~a))+p[5]+4237533241&4294967295,l=u+(h<<21&4294967295|h>>>11),h=a+(u^(l|~m))+p[12]+1700485571&4294967295,a=l+(h<<6&4294967295|h>>>26),h=m+(l^(a|~u))+p[3]+2399980690&4294967295,m=a+(h<<10&4294967295|h>>>22),h=u+(a^(m|~l))+p[10]+4293915773&4294967295,u=m+(h<<15&4294967295|h>>>17),h=l+(m^(u|~a))+p[1]+2240044497&4294967295,l=u+(h<<21&4294967295|h>>>11),h=a+(u^(l|~m))+p[8]+1873313359&4294967295,a=l+(h<<6&4294967295|h>>>26),h=m+(l^(a|~u))+p[15]+4264355552&4294967295,m=a+(h<<10&4294967295|h>>>22),h=u+(a^(m|~l))+p[6]+2734768916&4294967295,u=m+(h<<15&4294967295|h>>>17),h=l+(m^(u|~a))+p[13]+1309151649&4294967295,l=u+(h<<21&4294967295|h>>>11),h=a+(u^(l|~m))+p[4]+4149444226&4294967295,a=l+(h<<6&4294967295|h>>>26),h=m+(l^(a|~u))+p[11]+3174756917&4294967295,m=a+(h<<10&4294967295|h>>>22),h=u+(a^(m|~l))+p[2]+718787259&4294967295,u=m+(h<<15&4294967295|h>>>17),h=l+(m^(u|~a))+p[9]+3951481745&4294967295,f.g[0]=f.g[0]+a&4294967295,f.g[1]=f.g[1]+(u+(h<<21&4294967295|h>>>11))&4294967295,f.g[2]=f.g[2]+u&4294967295,f.g[3]=f.g[3]+m&4294967295}c.prototype.v=function(f,a){a===void 0&&(a=f.length);const l=a-this.blockSize,p=this.C;let u=this.h,m=0;for(;m<a;){if(u==0)for(;m<=l;)g(this,f,m),m+=this.blockSize;if(typeof f=="string"){for(;m<a;)if(p[u++]=f.charCodeAt(m++),u==this.blockSize){g(this,p),u=0;break}}else for(;m<a;)if(p[u++]=f[m++],u==this.blockSize){g(this,p),u=0;break}}this.h=u,this.o+=a},c.prototype.A=function(){var f=Array((this.h<56?this.blockSize:this.blockSize*2)-this.h);f[0]=128;for(var a=1;a<f.length-8;++a)f[a]=0;a=this.o*8;for(var l=f.length-8;l<f.length;++l)f[l]=a&255,a/=256;for(this.v(f),f=Array(16),a=0,l=0;l<4;++l)for(let p=0;p<32;p+=8)f[a++]=this.g[l]>>>p&255;return f};function w(f,a){var l=I;return Object.prototype.hasOwnProperty.call(l,f)?l[f]:l[f]=a(f)}function v(f,a){this.h=a;const l=[];let p=!0;for(let u=f.length-1;u>=0;u--){const m=f[u]|0;p&&m==a||(l[u]=m,p=!1)}this.g=l}var I={};function C(f){return-128<=f&&f<128?w(f,function(a){return new v([a|0],a<0?-1:0)}):new v([f|0],f<0?-1:0)}function E(f){if(isNaN(f)||!isFinite(f))return T;if(f<0)return R(E(-f));const a=[];let l=1;for(let p=0;f>=l;p++)a[p]=f/l|0,l*=4294967296;return new v(a,0)}function F(f,a){if(f.length==0)throw Error("number format error: empty string");if(a=a||10,a<2||36<a)throw Error("radix out of range: "+a);if(f.charAt(0)=="-")return R(F(f.substring(1),a));if(f.indexOf("-")>=0)throw Error('number format error: interior "-" character');const l=E(Math.pow(a,8));let p=T;for(let m=0;m<f.length;m+=8){var u=Math.min(8,f.length-m);const h=parseInt(f.substring(m,m+u),a);u<8?(u=E(Math.pow(a,u)),p=p.j(u).add(E(h))):(p=p.j(l),p=p.add(E(h)))}return p}var T=C(0),S=C(1),k=C(16777216);n=v.prototype,n.m=function(){if(j(this))return-R(this).m();let f=0,a=1;for(let l=0;l<this.g.length;l++){const p=this.i(l);f+=(p>=0?p:4294967296+p)*a,a*=4294967296}return f},n.toString=function(f){if(f=f||10,f<2||36<f)throw Error("radix out of range: "+f);if(B(this))return"0";if(j(this))return"-"+R(this).toString(f);const a=E(Math.pow(f,6));var l=this;let p="";for(;;){const u=J(l,a).g;l=G(l,u.j(a));let m=((l.g.length>0?l.g[0]:l.h)>>>0).toString(f);if(l=u,B(l))return m+p;for(;m.length<6;)m="0"+m;p=m+p}},n.i=function(f){return f<0?0:f<this.g.length?this.g[f]:this.h};function B(f){if(f.h!=0)return!1;for(let a=0;a<f.g.length;a++)if(f.g[a]!=0)return!1;return!0}function j(f){return f.h==-1}n.l=function(f){return f=G(this,f),j(f)?-1:B(f)?0:1};function R(f){const a=f.g.length,l=[];for(let p=0;p<a;p++)l[p]=~f.g[p];return new v(l,~f.h).add(S)}n.abs=function(){return j(this)?R(this):this},n.add=function(f){const a=Math.max(this.g.length,f.g.length),l=[];let p=0;for(let u=0;u<=a;u++){let m=p+(this.i(u)&65535)+(f.i(u)&65535),h=(m>>>16)+(this.i(u)>>>16)+(f.i(u)>>>16);p=h>>>16,m&=65535,h&=65535,l[u]=h<<16|m}return new v(l,l[l.length-1]&-2147483648?-1:0)};function G(f,a){return f.add(R(a))}n.j=function(f){if(B(this)||B(f))return T;if(j(this))return j(f)?R(this).j(R(f)):R(R(this).j(f));if(j(f))return R(this.j(R(f)));if(this.l(k)<0&&f.l(k)<0)return E(this.m()*f.m());const a=this.g.length+f.g.length,l=[];for(var p=0;p<2*a;p++)l[p]=0;for(p=0;p<this.g.length;p++)for(let u=0;u<f.g.length;u++){const m=this.i(p)>>>16,h=this.i(p)&65535,$=f.i(u)>>>16,ot=f.i(u)&65535;l[2*p+2*u]+=h*ot,W(l,2*p+2*u),l[2*p+2*u+1]+=m*ot,W(l,2*p+2*u+1),l[2*p+2*u+1]+=h*$,W(l,2*p+2*u+1),l[2*p+2*u+2]+=m*$,W(l,2*p+2*u+2)}for(f=0;f<a;f++)l[f]=l[2*f+1]<<16|l[2*f];for(f=a;f<2*a;f++)l[f]=0;return new v(l,0)};function W(f,a){for(;(f[a]&65535)!=f[a];)f[a+1]+=f[a]>>>16,f[a]&=65535,a++}function V(f,a){this.g=f,this.h=a}function J(f,a){if(B(a))throw Error("division by zero");if(B(f))return new V(T,T);if(j(f))return a=J(R(f),a),new V(R(a.g),R(a.h));if(j(a))return a=J(f,R(a)),new V(R(a.g),a.h);if(f.g.length>30){if(j(f)||j(a))throw Error("slowDivide_ only works with positive integers.");for(var l=S,p=a;p.l(f)<=0;)l=Y(l),p=Y(p);var u=z(l,1),m=z(p,1);for(p=z(p,2),l=z(l,2);!B(p);){var h=m.add(p);h.l(f)<=0&&(u=u.add(l),m=h),p=z(p,1),l=z(l,1)}return a=G(f,u.j(a)),new V(u,a)}for(u=T;f.l(a)>=0;){for(l=Math.max(1,Math.floor(f.m()/a.m())),p=Math.ceil(Math.log(l)/Math.LN2),p=p<=48?1:Math.pow(2,p-48),m=E(l),h=m.j(a);j(h)||h.l(f)>0;)l-=p,m=E(l),h=m.j(a);B(m)&&(m=S),u=u.add(m),f=G(f,h)}return new V(u,f)}n.B=function(f){return J(this,f).h},n.and=function(f){const a=Math.max(this.g.length,f.g.length),l=[];for(let p=0;p<a;p++)l[p]=this.i(p)&f.i(p);return new v(l,this.h&f.h)},n.or=function(f){const a=Math.max(this.g.length,f.g.length),l=[];for(let p=0;p<a;p++)l[p]=this.i(p)|f.i(p);return new v(l,this.h|f.h)},n.xor=function(f){const a=Math.max(this.g.length,f.g.length),l=[];for(let p=0;p<a;p++)l[p]=this.i(p)^f.i(p);return new v(l,this.h^f.h)};function Y(f){const a=f.g.length+1,l=[];for(let p=0;p<a;p++)l[p]=f.i(p)<<1|f.i(p-1)>>>31;return new v(l,f.h)}function z(f,a){const l=a>>5;a%=32;const p=f.g.length-l,u=[];for(let m=0;m<p;m++)u[m]=a>0?f.i(m+l)>>>a|f.i(m+l+1)<<32-a:f.i(m+l);return new v(u,f.h)}c.prototype.digest=c.prototype.A,c.prototype.reset=c.prototype.u,c.prototype.update=c.prototype.v,uo=c,v.prototype.add=v.prototype.add,v.prototype.multiply=v.prototype.j,v.prototype.modulo=v.prototype.B,v.prototype.compare=v.prototype.l,v.prototype.toNumber=v.prototype.m,v.prototype.toString=v.prototype.toString,v.prototype.getBits=v.prototype.i,v.fromNumber=E,v.fromString=F,lo=v}).apply(typeof di<"u"?di:typeof self<"u"?self:typeof window<"u"?window:{});var re=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{};/** @license
Copyright The Closure Library Authors.
SPDX-License-Identifier: Apache-2.0
*/var fo,po,go,mo,yo,vo,wo,bo;(function(){var n,i=Object.defineProperty;function s(t){t=[typeof globalThis=="object"&&globalThis,t,typeof window=="object"&&window,typeof self=="object"&&self,typeof re=="object"&&re];for(var e=0;e<t.length;++e){var r=t[e];if(r&&r.Math==Math)return r}throw Error("Cannot find global object")}var c=s(this);function g(t,e){if(e)t:{var r=c;t=t.split(".");for(var o=0;o<t.length-1;o++){var d=t[o];if(!(d in r))break t;r=r[d]}t=t[t.length-1],o=r[t],e=e(o),e!=o&&e!=null&&i(r,t,{configurable:!0,writable:!0,value:e})}}g("Symbol.dispose",function(t){return t||Symbol("Symbol.dispose")}),g("Array.prototype.values",function(t){return t||function(){return this[Symbol.iterator]()}}),g("Object.entries",function(t){return t||function(e){var r=[],o;for(o in e)Object.prototype.hasOwnProperty.call(e,o)&&r.push([o,e[o]]);return r}});/** @license

 Copyright The Closure Library Authors.
 SPDX-License-Identifier: Apache-2.0
*/var w=w||{},v=this||self;function I(t){var e=typeof t;return e=="object"&&t!=null||e=="function"}function C(t,e,r){return t.call.apply(t.bind,arguments)}function E(t,e,r){return E=C,E.apply(null,arguments)}function F(t,e){var r=Array.prototype.slice.call(arguments,1);return function(){var o=r.slice();return o.push.apply(o,arguments),t.apply(this,o)}}function T(t,e){function r(){}r.prototype=e.prototype,t.Z=e.prototype,t.prototype=new r,t.prototype.constructor=t,t.Ob=function(o,d,y){for(var b=Array(arguments.length-2),A=2;A<arguments.length;A++)b[A-2]=arguments[A];return e.prototype[d].apply(o,b)}}var S=typeof AsyncContext<"u"&&typeof AsyncContext.Snapshot=="function"?t=>t&&AsyncContext.Snapshot.wrap(t):t=>t;function k(t){const e=t.length;if(e>0){const r=Array(e);for(let o=0;o<e;o++)r[o]=t[o];return r}return[]}function B(t,e){for(let o=1;o<arguments.length;o++){const d=arguments[o];var r=typeof d;if(r=r!="object"?r:d?Array.isArray(d)?"array":r:"null",r=="array"||r=="object"&&typeof d.length=="number"){r=t.length||0;const y=d.length||0;t.length=r+y;for(let b=0;b<y;b++)t[r+b]=d[b]}else t.push(d)}}class j{constructor(e,r){this.i=e,this.j=r,this.h=0,this.g=null}get(){let e;return this.h>0?(this.h--,e=this.g,this.g=e.next,e.next=null):e=this.i(),e}}function R(t){v.setTimeout(()=>{throw t},0)}function G(){var t=f;let e=null;return t.g&&(e=t.g,t.g=t.g.next,t.g||(t.h=null),e.next=null),e}class W{constructor(){this.h=this.g=null}add(e,r){const o=V.get();o.set(e,r),this.h?this.h.next=o:this.g=o,this.h=o}}var V=new j(()=>new J,t=>t.reset());class J{constructor(){this.next=this.g=this.h=null}set(e,r){this.h=e,this.g=r,this.next=null}reset(){this.next=this.g=this.h=null}}let Y,z=!1,f=new W,a=()=>{const t=Promise.resolve(void 0);Y=()=>{t.then(l)}};function l(){for(var t;t=G();){try{t.h.call(t.g)}catch(r){R(r)}var e=V;e.j(t),e.h<100&&(e.h++,t.next=e.g,e.g=t)}z=!1}function p(){this.u=this.u,this.C=this.C}p.prototype.u=!1,p.prototype.dispose=function(){this.u||(this.u=!0,this.N())},p.prototype[Symbol.dispose]=function(){this.dispose()},p.prototype.N=function(){if(this.C)for(;this.C.length;)this.C.shift()()};function u(t,e){this.type=t,this.g=this.target=e,this.defaultPrevented=!1}u.prototype.h=function(){this.defaultPrevented=!0};var m=(function(){if(!v.addEventListener||!Object.defineProperty)return!1;var t=!1,e=Object.defineProperty({},"passive",{get:function(){t=!0}});try{const r=()=>{};v.addEventListener("test",r,e),v.removeEventListener("test",r,e)}catch{}return t})();function h(t){return/^[\s\xa0]*$/.test(t)}function $(t,e){u.call(this,t?t.type:""),this.relatedTarget=this.g=this.target=null,this.button=this.screenY=this.screenX=this.clientY=this.clientX=0,this.key="",this.metaKey=this.shiftKey=this.altKey=this.ctrlKey=!1,this.state=null,this.pointerId=0,this.pointerType="",this.i=null,t&&this.init(t,e)}T($,u),$.prototype.init=function(t,e){const r=this.type=t.type,o=t.changedTouches&&t.changedTouches.length?t.changedTouches[0]:null;this.target=t.target||t.srcElement,this.g=e,e=t.relatedTarget,e||(r=="mouseover"?e=t.fromElement:r=="mouseout"&&(e=t.toElement)),this.relatedTarget=e,o?(this.clientX=o.clientX!==void 0?o.clientX:o.pageX,this.clientY=o.clientY!==void 0?o.clientY:o.pageY,this.screenX=o.screenX||0,this.screenY=o.screenY||0):(this.clientX=t.clientX!==void 0?t.clientX:t.pageX,this.clientY=t.clientY!==void 0?t.clientY:t.pageY,this.screenX=t.screenX||0,this.screenY=t.screenY||0),this.button=t.button,this.key=t.key||"",this.ctrlKey=t.ctrlKey,this.altKey=t.altKey,this.shiftKey=t.shiftKey,this.metaKey=t.metaKey,this.pointerId=t.pointerId||0,this.pointerType=t.pointerType,this.state=t.state,this.i=t,t.defaultPrevented&&$.Z.h.call(this)},$.prototype.h=function(){$.Z.h.call(this);const t=this.i;t.preventDefault?t.preventDefault():t.returnValue=!1};var ot="closure_listenable_"+(Math.random()*1e6|0),Gi=0;function Ki(t,e,r,o,d){this.listener=t,this.proxy=null,this.src=e,this.type=r,this.capture=!!o,this.ha=d,this.key=++Gi,this.da=this.fa=!1}function Vt(t){t.da=!0,t.listener=null,t.proxy=null,t.src=null,t.ha=null}function zt(t,e,r){for(const o in t)e.call(r,t[o],o,t)}function Ji(t,e){for(const r in t)e.call(void 0,t[r],r,t)}function nn(t){const e={};for(const r in t)e[r]=t[r];return e}const rn="constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf".split(" ");function sn(t,e){let r,o;for(let d=1;d<arguments.length;d++){o=arguments[d];for(r in o)t[r]=o[r];for(let y=0;y<rn.length;y++)r=rn[y],Object.prototype.hasOwnProperty.call(o,r)&&(t[r]=o[r])}}function Wt(t){this.src=t,this.g={},this.h=0}Wt.prototype.add=function(t,e,r,o,d){const y=t.toString();t=this.g[y],t||(t=this.g[y]=[],this.h++);const b=pe(t,e,o,d);return b>-1?(e=t[b],r||(e.fa=!1)):(e=new Ki(e,this.src,y,!!o,d),e.fa=r,t.push(e)),e};function fe(t,e){const r=e.type;if(r in t.g){var o=t.g[r],d=Array.prototype.indexOf.call(o,e,void 0),y;(y=d>=0)&&Array.prototype.splice.call(o,d,1),y&&(Vt(e),t.g[r].length==0&&(delete t.g[r],t.h--))}}function pe(t,e,r,o){for(let d=0;d<t.length;++d){const y=t[d];if(!y.da&&y.listener==e&&y.capture==!!r&&y.ha==o)return d}return-1}var ge="closure_lm_"+(Math.random()*1e6|0),de={};function on(t,e,r,o,d){if(Array.isArray(e)){for(let y=0;y<e.length;y++)on(t,e[y],r,o,d);return null}return r=cn(r),t&&t[ot]?t.J(e,r,I(o)?!!o.capture:!1,d):Yi(t,e,r,!1,o,d)}function Yi(t,e,r,o,d,y){if(!e)throw Error("Invalid event type");const b=I(d)?!!d.capture:!!d;let A=ye(t);if(A||(t[ge]=A=new Wt(t)),r=A.add(e,r,o,b,y),r.proxy)return r;if(o=Zi(),r.proxy=o,o.src=t,o.listener=r,t.addEventListener)m||(d=b),d===void 0&&(d=!1),t.addEventListener(e.toString(),o,d);else if(t.attachEvent)t.attachEvent(hn(e.toString()),o);else if(t.addListener&&t.removeListener)t.addListener(o);else throw Error("addEventListener and attachEvent are unavailable.");return r}function Zi(){function t(r){return e.call(t.src,t.listener,r)}const e=Qi;return t}function an(t,e,r,o,d){if(Array.isArray(e))for(var y=0;y<e.length;y++)an(t,e[y],r,o,d);else o=I(o)?!!o.capture:!!o,r=cn(r),t&&t[ot]?(t=t.i,y=String(e).toString(),y in t.g&&(e=t.g[y],r=pe(e,r,o,d),r>-1&&(Vt(e[r]),Array.prototype.splice.call(e,r,1),e.length==0&&(delete t.g[y],t.h--)))):t&&(t=ye(t))&&(e=t.g[e.toString()],t=-1,e&&(t=pe(e,r,o,d)),(r=t>-1?e[t]:null)&&me(r))}function me(t){if(typeof t!="number"&&t&&!t.da){var e=t.src;if(e&&e[ot])fe(e.i,t);else{var r=t.type,o=t.proxy;e.removeEventListener?e.removeEventListener(r,o,t.capture):e.detachEvent?e.detachEvent(hn(r),o):e.addListener&&e.removeListener&&e.removeListener(o),(r=ye(e))?(fe(r,t),r.h==0&&(r.src=null,e[ge]=null)):Vt(t)}}}function hn(t){return t in de?de[t]:de[t]="on"+t}function Qi(t,e){if(t.da)t=!0;else{e=new $(e,this);const r=t.listener,o=t.ha||t.src;t.fa&&me(t),t=r.call(o,e)}return t}function ye(t){return t=t[ge],t instanceof Wt?t:null}var ve="__closure_events_fn_"+(Math.random()*1e9>>>0);function cn(t){return typeof t=="function"?t:(t[ve]||(t[ve]=function(e){return t.handleEvent(e)}),t[ve])}function N(){p.call(this),this.i=new Wt(this),this.M=this,this.G=null}T(N,p),N.prototype[ot]=!0,N.prototype.removeEventListener=function(t,e,r,o){an(this,t,e,r,o)};function L(t,e){var r,o=t.G;if(o)for(r=[];o;o=o.G)r.push(o);if(t=t.M,o=e.type||e,typeof e=="string")e=new u(e,t);else if(e instanceof u)e.target=e.target||t;else{var d=e;e=new u(o,t),sn(e,d)}d=!0;let y,b;if(r)for(b=r.length-1;b>=0;b--)y=e.g=r[b],d=Xt(y,o,!0,e)&&d;if(y=e.g=t,d=Xt(y,o,!0,e)&&d,d=Xt(y,o,!1,e)&&d,r)for(b=0;b<r.length;b++)y=e.g=r[b],d=Xt(y,o,!1,e)&&d}N.prototype.N=function(){if(N.Z.N.call(this),this.i){var t=this.i;for(const e in t.g){const r=t.g[e];for(let o=0;o<r.length;o++)Vt(r[o]);delete t.g[e],t.h--}}this.G=null},N.prototype.J=function(t,e,r,o){return this.i.add(String(t),e,!1,r,o)},N.prototype.K=function(t,e,r,o){return this.i.add(String(t),e,!0,r,o)};function Xt(t,e,r,o){if(e=t.i.g[String(e)],!e)return!0;e=e.concat();let d=!0;for(let y=0;y<e.length;++y){const b=e[y];if(b&&!b.da&&b.capture==r){const A=b.listener,P=b.ha||b.src;b.fa&&fe(t.i,b),d=A.call(P,o)!==!1&&d}}return d&&!o.defaultPrevented}function tr(t,e){if(typeof t!="function")if(t&&typeof t.handleEvent=="function")t=E(t.handleEvent,t);else throw Error("Invalid listener argument");return Number(e)>2147483647?-1:v.setTimeout(t,e||0)}function ln(t){t.g=tr(()=>{t.g=null,t.i&&(t.i=!1,ln(t))},t.l);const e=t.h;t.h=null,t.m.apply(null,e)}class er extends p{constructor(e,r){super(),this.m=e,this.l=r,this.h=null,this.i=!1,this.g=null}j(e){this.h=arguments,this.g?this.i=!0:ln(this)}N(){super.N(),this.g&&(v.clearTimeout(this.g),this.g=null,this.i=!1,this.h=null)}}function It(t){p.call(this),this.h=t,this.g={}}T(It,p);var un=[];function fn(t){zt(t.g,function(e,r){this.g.hasOwnProperty(r)&&me(e)},t),t.g={}}It.prototype.N=function(){It.Z.N.call(this),fn(this)},It.prototype.handleEvent=function(){throw Error("EventHandler.handleEvent not implemented")};var we=v.JSON.stringify,nr=v.JSON.parse,ir=class{stringify(t){return v.JSON.stringify(t,void 0)}parse(t){return v.JSON.parse(t,void 0)}};function pn(){}function gn(){}var Ct={OPEN:"a",hb:"b",ERROR:"c",tb:"d"};function be(){u.call(this,"d")}T(be,u);function Ee(){u.call(this,"c")}T(Ee,u);var at={},dn=null;function qt(){return dn=dn||new N}at.Ia="serverreachability";function mn(t){u.call(this,at.Ia,t)}T(mn,u);function At(t){const e=qt();L(e,new mn(e))}at.STAT_EVENT="statevent";function yn(t,e){u.call(this,at.STAT_EVENT,t),this.stat=e}T(yn,u);function H(t){const e=qt();L(e,new yn(e,t))}at.Ja="timingevent";function vn(t,e){u.call(this,at.Ja,t),this.size=e}T(vn,u);function Tt(t,e){if(typeof t!="function")throw Error("Fn must not be null and must be a function");return v.setTimeout(function(){t()},e)}function _t(){this.g=!0}_t.prototype.ua=function(){this.g=!1};function rr(t,e,r,o,d,y){t.info(function(){if(t.g)if(y){var b="",A=y.split("&");for(let _=0;_<A.length;_++){var P=A[_].split("=");if(P.length>1){const x=P[0];P=P[1];const q=x.split("_");b=q.length>=2&&q[1]=="type"?b+(x+"="+P+"&"):b+(x+"=redacted&")}}}else b=null;else b=y;return"XMLHTTP REQ ("+o+") [attempt "+d+"]: "+e+`
`+r+`
`+b})}function sr(t,e,r,o,d,y,b){t.info(function(){return"XMLHTTP RESP ("+o+") [ attempt "+d+"]: "+e+`
`+r+`
`+y+" "+b})}function vt(t,e,r,o){t.info(function(){return"XMLHTTP TEXT ("+e+"): "+ar(t,r)+(o?" "+o:"")})}function or(t,e){t.info(function(){return"TIMEOUT: "+e})}_t.prototype.info=function(){};function ar(t,e){if(!t.g)return e;if(!e)return null;try{const y=JSON.parse(e);if(y){for(t=0;t<y.length;t++)if(Array.isArray(y[t])){var r=y[t];if(!(r.length<2)){var o=r[1];if(Array.isArray(o)&&!(o.length<1)){var d=o[0];if(d!="noop"&&d!="stop"&&d!="close")for(let b=1;b<o.length;b++)o[b]=""}}}}return we(y)}catch{return e}}var Gt={NO_ERROR:0,cb:1,qb:2,pb:3,kb:4,ob:5,rb:6,Ga:7,TIMEOUT:8,ub:9},wn={ib:"complete",Fb:"success",ERROR:"error",Ga:"abort",xb:"ready",yb:"readystatechange",TIMEOUT:"timeout",sb:"incrementaldata",wb:"progress",lb:"downloadprogress",Nb:"uploadprogress"},bn;function Se(){}T(Se,pn),Se.prototype.g=function(){return new XMLHttpRequest},bn=new Se;function Dt(t){return encodeURIComponent(String(t))}function hr(t){var e=1;t=t.split(":");const r=[];for(;e>0&&t.length;)r.push(t.shift()),e--;return t.length&&r.push(t.join(":")),r}function Z(t,e,r,o){this.j=t,this.i=e,this.l=r,this.S=o||1,this.V=new It(this),this.H=45e3,this.J=null,this.o=!1,this.u=this.B=this.A=this.M=this.F=this.T=this.D=null,this.G=[],this.g=null,this.C=0,this.m=this.v=null,this.X=-1,this.K=!1,this.P=0,this.O=null,this.W=this.L=this.U=this.R=!1,this.h=new En}function En(){this.i=null,this.g="",this.h=!1}var Sn={},Ie={};function Ce(t,e,r){t.M=1,t.A=Jt(X(e)),t.u=r,t.R=!0,In(t,null)}function In(t,e){t.F=Date.now(),Kt(t),t.B=X(t.A);var r=t.B,o=t.S;Array.isArray(o)||(o=[String(o)]),jn(r.i,"t",o),t.C=0,r=t.j.L,t.h=new En,t.g=ti(t.j,r?e:null,!t.u),t.P>0&&(t.O=new er(E(t.Y,t,t.g),t.P)),e=t.V,r=t.g,o=t.ba;var d="readystatechange";Array.isArray(d)||(d&&(un[0]=d.toString()),d=un);for(let y=0;y<d.length;y++){const b=on(r,d[y],o||e.handleEvent,!1,e.h||e);if(!b)break;e.g[b.key]=b}e=t.J?nn(t.J):{},t.u?(t.v||(t.v="POST"),e["Content-Type"]="application/x-www-form-urlencoded",t.g.ea(t.B,t.v,t.u,e)):(t.v="GET",t.g.ea(t.B,t.v,null,e)),At(),rr(t.i,t.v,t.B,t.l,t.S,t.u)}Z.prototype.ba=function(t){t=t.target;const e=this.O;e&&et(t)==3?e.j():this.Y(t)},Z.prototype.Y=function(t){try{if(t==this.g)t:{const A=et(this.g),P=this.g.ya(),_=this.g.ca();if(!(A<3)&&(A!=3||this.g&&(this.h.h||this.g.la()||Vn(this.g)))){this.K||A!=4||P==7||(P==8||_<=0?At(3):At(2)),Ae(this);var e=this.g.ca();this.X=e;var r=cr(this);if(this.o=e==200,sr(this.i,this.v,this.B,this.l,this.S,A,e),this.o){if(this.U&&!this.L){e:{if(this.g){var o,d=this.g;if((o=d.g?d.g.getResponseHeader("X-HTTP-Initial-Response"):null)&&!h(o)){var y=o;break e}}y=null}if(t=y)vt(this.i,this.l,t,"Initial handshake response via X-HTTP-Initial-Response"),this.L=!0,Te(this,t);else{this.o=!1,this.m=3,H(12),ht(this),Ot(this);break t}}if(this.R){t=!0;let x;for(;!this.K&&this.C<r.length;)if(x=lr(this,r),x==Ie){A==4&&(this.m=4,H(14),t=!1),vt(this.i,this.l,null,"[Incomplete Response]");break}else if(x==Sn){this.m=4,H(15),vt(this.i,this.l,r,"[Invalid Chunk]"),t=!1;break}else vt(this.i,this.l,x,null),Te(this,x);if(Cn(this)&&this.C!=0&&(this.h.g=this.h.g.slice(this.C),this.C=0),A!=4||r.length!=0||this.h.h||(this.m=1,H(16),t=!1),this.o=this.o&&t,!t)vt(this.i,this.l,r,"[Invalid Chunked Response]"),ht(this),Ot(this);else if(r.length>0&&!this.W){this.W=!0;var b=this.j;b.g==this&&b.aa&&!b.P&&(b.j.info("Great, no buffering proxy detected. Bytes received: "+r.length),ke(b),b.P=!0,H(11))}}else vt(this.i,this.l,r,null),Te(this,r);A==4&&ht(this),this.o&&!this.K&&(A==4?Jn(this.j,this):(this.o=!1,Kt(this)))}else Cr(this.g),e==400&&r.indexOf("Unknown SID")>0?(this.m=3,H(12)):(this.m=0,H(13)),ht(this),Ot(this)}}}catch{}finally{}};function cr(t){if(!Cn(t))return t.g.la();const e=Vn(t.g);if(e==="")return"";let r="";const o=e.length,d=et(t.g)==4;if(!t.h.i){if(typeof TextDecoder>"u")return ht(t),Ot(t),"";t.h.i=new v.TextDecoder}for(let y=0;y<o;y++)t.h.h=!0,r+=t.h.i.decode(e[y],{stream:!(d&&y==o-1)});return e.length=0,t.h.g+=r,t.C=0,t.h.g}function Cn(t){return t.g?t.v=="GET"&&t.M!=2&&t.j.Aa:!1}function lr(t,e){var r=t.C,o=e.indexOf(`
`,r);return o==-1?Ie:(r=Number(e.substring(r,o)),isNaN(r)?Sn:(o+=1,o+r>e.length?Ie:(e=e.slice(o,o+r),t.C=o+r,e)))}Z.prototype.cancel=function(){this.K=!0,ht(this)};function Kt(t){t.T=Date.now()+t.H,An(t,t.H)}function An(t,e){if(t.D!=null)throw Error("WatchDog timer not null");t.D=Tt(E(t.aa,t),e)}function Ae(t){t.D&&(v.clearTimeout(t.D),t.D=null)}Z.prototype.aa=function(){this.D=null;const t=Date.now();t-this.T>=0?(or(this.i,this.B),this.M!=2&&(At(),H(17)),ht(this),this.m=2,Ot(this)):An(this,this.T-t)};function Ot(t){t.j.I==0||t.K||Jn(t.j,t)}function ht(t){Ae(t);var e=t.O;e&&typeof e.dispose=="function"&&e.dispose(),t.O=null,fn(t.V),t.g&&(e=t.g,t.g=null,e.abort(),e.dispose())}function Te(t,e){try{var r=t.j;if(r.I!=0&&(r.g==t||_e(r.h,t))){if(!t.L&&_e(r.h,t)&&r.I==3){try{var o=r.Ba.g.parse(e)}catch{o=null}if(Array.isArray(o)&&o.length==3){var d=o;if(d[0]==0){t:if(!r.v){if(r.g)if(r.g.F+3e3<t.F)ee(r),Qt(r);else break t;Pe(r),H(18)}}else r.xa=d[1],0<r.xa-r.K&&d[2]<37500&&r.F&&r.A==0&&!r.C&&(r.C=Tt(E(r.Va,r),6e3));Dn(r.h)<=1&&r.ta&&(r.ta=void 0)}else lt(r,11)}else if((t.L||r.g==t)&&ee(r),!h(e))for(d=r.Ba.g.parse(e),e=0;e<d.length;e++){let _=d[e];const x=_[0];if(!(x<=r.K))if(r.K=x,_=_[1],r.I==2)if(_[0]=="c"){r.M=_[1],r.ba=_[2];const q=_[3];q!=null&&(r.ka=q,r.j.info("VER="+r.ka));const ut=_[4];ut!=null&&(r.za=ut,r.j.info("SVER="+r.za));const nt=_[5];nt!=null&&typeof nt=="number"&&nt>0&&(o=1.5*nt,r.O=o,r.j.info("backChannelRequestTimeoutMs_="+o)),o=r;const it=t.g;if(it){const ie=it.g?it.g.getResponseHeader("X-Client-Wire-Protocol"):null;if(ie){var y=o.h;y.g||ie.indexOf("spdy")==-1&&ie.indexOf("quic")==-1&&ie.indexOf("h2")==-1||(y.j=y.l,y.g=new Set,y.h&&(De(y,y.h),y.h=null))}if(o.G){const xe=it.g?it.g.getResponseHeader("X-HTTP-Session-Id"):null;xe&&(o.wa=xe,D(o.J,o.G,xe))}}r.I=3,r.l&&r.l.ra(),r.aa&&(r.T=Date.now()-t.F,r.j.info("Handshake RTT: "+r.T+"ms")),o=r;var b=t;if(o.na=Qn(o,o.L?o.ba:null,o.W),b.L){On(o.h,b);var A=b,P=o.O;P&&(A.H=P),A.D&&(Ae(A),Kt(A)),o.g=b}else Gn(o);r.i.length>0&&te(r)}else _[0]!="stop"&&_[0]!="close"||lt(r,7);else r.I==3&&(_[0]=="stop"||_[0]=="close"?_[0]=="stop"?lt(r,7):Be(r):_[0]!="noop"&&r.l&&r.l.qa(_),r.A=0)}}At(4)}catch{}}var ur=class{constructor(t,e){this.g=t,this.map=e}};function Tn(t){this.l=t||10,v.PerformanceNavigationTiming?(t=v.performance.getEntriesByType("navigation"),t=t.length>0&&(t[0].nextHopProtocol=="hq"||t[0].nextHopProtocol=="h2")):t=!!(v.chrome&&v.chrome.loadTimes&&v.chrome.loadTimes()&&v.chrome.loadTimes().wasFetchedViaSpdy),this.j=t?this.l:1,this.g=null,this.j>1&&(this.g=new Set),this.h=null,this.i=[]}function _n(t){return t.h?!0:t.g?t.g.size>=t.j:!1}function Dn(t){return t.h?1:t.g?t.g.size:0}function _e(t,e){return t.h?t.h==e:t.g?t.g.has(e):!1}function De(t,e){t.g?t.g.add(e):t.h=e}function On(t,e){t.h&&t.h==e?t.h=null:t.g&&t.g.has(e)&&t.g.delete(e)}Tn.prototype.cancel=function(){if(this.i=Rn(this),this.h)this.h.cancel(),this.h=null;else if(this.g&&this.g.size!==0){for(const t of this.g.values())t.cancel();this.g.clear()}};function Rn(t){if(t.h!=null)return t.i.concat(t.h.G);if(t.g!=null&&t.g.size!==0){let e=t.i;for(const r of t.g.values())e=e.concat(r.G);return e}return k(t.i)}var Mn=RegExp("^(?:([^:/?#.]+):)?(?://(?:([^\\\\/?#]*)@)?([^\\\\/?#]*?)(?::([0-9]+))?(?=[\\\\/?#]|$))?([^?#]+)?(?:\\?([^#]*))?(?:#([\\s\\S]*))?$");function fr(t,e){if(t){t=t.split("&");for(let r=0;r<t.length;r++){const o=t[r].indexOf("=");let d,y=null;o>=0?(d=t[r].substring(0,o),y=t[r].substring(o+1)):d=t[r],e(d,y?decodeURIComponent(y.replace(/\+/g," ")):"")}}}function Q(t){this.g=this.o=this.j="",this.u=null,this.m=this.h="",this.l=!1;let e;t instanceof Q?(this.l=t.l,Rt(this,t.j),this.o=t.o,this.g=t.g,Mt(this,t.u),this.h=t.h,Oe(this,Nn(t.i)),this.m=t.m):t&&(e=String(t).match(Mn))?(this.l=!1,Rt(this,e[1]||"",!0),this.o=Bt(e[2]||""),this.g=Bt(e[3]||"",!0),Mt(this,e[4]),this.h=Bt(e[5]||"",!0),Oe(this,e[6]||"",!0),this.m=Bt(e[7]||"")):(this.l=!1,this.i=new kt(null,this.l))}Q.prototype.toString=function(){const t=[];var e=this.j;e&&t.push(Pt(e,Bn,!0),":");var r=this.g;return(r||e=="file")&&(t.push("//"),(e=this.o)&&t.push(Pt(e,Bn,!0),"@"),t.push(Dt(r).replace(/%25([0-9a-fA-F]{2})/g,"%$1")),r=this.u,r!=null&&t.push(":",String(r))),(r=this.h)&&(this.g&&r.charAt(0)!="/"&&t.push("/"),t.push(Pt(r,r.charAt(0)=="/"?dr:gr,!0))),(r=this.i.toString())&&t.push("?",r),(r=this.m)&&t.push("#",Pt(r,yr)),t.join("")},Q.prototype.resolve=function(t){const e=X(this);let r=!!t.j;r?Rt(e,t.j):r=!!t.o,r?e.o=t.o:r=!!t.g,r?e.g=t.g:r=t.u!=null;var o=t.h;if(r)Mt(e,t.u);else if(r=!!t.h){if(o.charAt(0)!="/")if(this.g&&!this.h)o="/"+o;else{var d=e.h.lastIndexOf("/");d!=-1&&(o=e.h.slice(0,d+1)+o)}if(d=o,d==".."||d==".")o="";else if(d.indexOf("./")!=-1||d.indexOf("/.")!=-1){o=d.lastIndexOf("/",0)==0,d=d.split("/");const y=[];for(let b=0;b<d.length;){const A=d[b++];A=="."?o&&b==d.length&&y.push(""):A==".."?((y.length>1||y.length==1&&y[0]!="")&&y.pop(),o&&b==d.length&&y.push("")):(y.push(A),o=!0)}o=y.join("/")}else o=d}return r?e.h=o:r=t.i.toString()!=="",r?Oe(e,Nn(t.i)):r=!!t.m,r&&(e.m=t.m),e};function X(t){return new Q(t)}function Rt(t,e,r){t.j=r?Bt(e,!0):e,t.j&&(t.j=t.j.replace(/:$/,""))}function Mt(t,e){if(e){if(e=Number(e),isNaN(e)||e<0)throw Error("Bad port number "+e);t.u=e}else t.u=null}function Oe(t,e,r){e instanceof kt?(t.i=e,vr(t.i,t.l)):(r||(e=Pt(e,mr)),t.i=new kt(e,t.l))}function D(t,e,r){t.i.set(e,r)}function Jt(t){return D(t,"zx",Math.floor(Math.random()*2147483648).toString(36)+Math.abs(Math.floor(Math.random()*2147483648)^Date.now()).toString(36)),t}function Bt(t,e){return t?e?decodeURI(t.replace(/%25/g,"%2525")):decodeURIComponent(t):""}function Pt(t,e,r){return typeof t=="string"?(t=encodeURI(t).replace(e,pr),r&&(t=t.replace(/%25([0-9a-fA-F]{2})/g,"%$1")),t):null}function pr(t){return t=t.charCodeAt(0),"%"+(t>>4&15).toString(16)+(t&15).toString(16)}var Bn=/[#\/\?@]/g,gr=/[#\?:]/g,dr=/[#\?]/g,mr=/[#\?@]/g,yr=/#/g;function kt(t,e){this.h=this.g=null,this.i=t||null,this.j=!!e}function ct(t){t.g||(t.g=new Map,t.h=0,t.i&&fr(t.i,function(e,r){t.add(decodeURIComponent(e.replace(/\+/g," ")),r)}))}n=kt.prototype,n.add=function(t,e){ct(this),this.i=null,t=wt(this,t);let r=this.g.get(t);return r||this.g.set(t,r=[]),r.push(e),this.h+=1,this};function Pn(t,e){ct(t),e=wt(t,e),t.g.has(e)&&(t.i=null,t.h-=t.g.get(e).length,t.g.delete(e))}function kn(t,e){return ct(t),e=wt(t,e),t.g.has(e)}n.forEach=function(t,e){ct(this),this.g.forEach(function(r,o){r.forEach(function(d){t.call(e,d,o,this)},this)},this)};function xn(t,e){ct(t);let r=[];if(typeof e=="string")kn(t,e)&&(r=r.concat(t.g.get(wt(t,e))));else for(t=Array.from(t.g.values()),e=0;e<t.length;e++)r=r.concat(t[e]);return r}n.set=function(t,e){return ct(this),this.i=null,t=wt(this,t),kn(this,t)&&(this.h-=this.g.get(t).length),this.g.set(t,[e]),this.h+=1,this},n.get=function(t,e){return t?(t=xn(this,t),t.length>0?String(t[0]):e):e};function jn(t,e,r){Pn(t,e),r.length>0&&(t.i=null,t.g.set(wt(t,e),k(r)),t.h+=r.length)}n.toString=function(){if(this.i)return this.i;if(!this.g)return"";const t=[],e=Array.from(this.g.keys());for(let o=0;o<e.length;o++){var r=e[o];const d=Dt(r);r=xn(this,r);for(let y=0;y<r.length;y++){let b=d;r[y]!==""&&(b+="="+Dt(r[y])),t.push(b)}}return this.i=t.join("&")};function Nn(t){const e=new kt;return e.i=t.i,t.g&&(e.g=new Map(t.g),e.h=t.h),e}function wt(t,e){return e=String(e),t.j&&(e=e.toLowerCase()),e}function vr(t,e){e&&!t.j&&(ct(t),t.i=null,t.g.forEach(function(r,o){const d=o.toLowerCase();o!=d&&(Pn(this,o),jn(this,d,r))},t)),t.j=e}function wr(t,e){const r=new _t;if(v.Image){const o=new Image;o.onload=F(tt,r,"TestLoadImage: loaded",!0,e,o),o.onerror=F(tt,r,"TestLoadImage: error",!1,e,o),o.onabort=F(tt,r,"TestLoadImage: abort",!1,e,o),o.ontimeout=F(tt,r,"TestLoadImage: timeout",!1,e,o),v.setTimeout(function(){o.ontimeout&&o.ontimeout()},1e4),o.src=t}else e(!1)}function br(t,e){const r=new _t,o=new AbortController,d=setTimeout(()=>{o.abort(),tt(r,"TestPingServer: timeout",!1,e)},1e4);fetch(t,{signal:o.signal}).then(y=>{clearTimeout(d),y.ok?tt(r,"TestPingServer: ok",!0,e):tt(r,"TestPingServer: server error",!1,e)}).catch(()=>{clearTimeout(d),tt(r,"TestPingServer: error",!1,e)})}function tt(t,e,r,o,d){try{d&&(d.onload=null,d.onerror=null,d.onabort=null,d.ontimeout=null),o(r)}catch{}}function Er(){this.g=new ir}function Re(t){this.i=t.Sb||null,this.h=t.ab||!1}T(Re,pn),Re.prototype.g=function(){return new Yt(this.i,this.h)};function Yt(t,e){N.call(this),this.H=t,this.o=e,this.m=void 0,this.status=this.readyState=0,this.responseType=this.responseText=this.response=this.statusText="",this.onreadystatechange=null,this.A=new Headers,this.h=null,this.F="GET",this.D="",this.g=!1,this.B=this.j=this.l=null,this.v=new AbortController}T(Yt,N),n=Yt.prototype,n.open=function(t,e){if(this.readyState!=0)throw this.abort(),Error("Error reopening a connection");this.F=t,this.D=e,this.readyState=1,jt(this)},n.send=function(t){if(this.readyState!=1)throw this.abort(),Error("need to call open() first. ");if(this.v.signal.aborted)throw this.abort(),Error("Request was aborted.");this.g=!0;const e={headers:this.A,method:this.F,credentials:this.m,cache:void 0,signal:this.v.signal};t&&(e.body=t),(this.H||v).fetch(new Request(this.D,e)).then(this.Pa.bind(this),this.ga.bind(this))},n.abort=function(){this.response=this.responseText="",this.A=new Headers,this.status=0,this.v.abort(),this.j&&this.j.cancel("Request was aborted.").catch(()=>{}),this.readyState>=1&&this.g&&this.readyState!=4&&(this.g=!1,xt(this)),this.readyState=0},n.Pa=function(t){if(this.g&&(this.l=t,this.h||(this.status=this.l.status,this.statusText=this.l.statusText,this.h=t.headers,this.readyState=2,jt(this)),this.g&&(this.readyState=3,jt(this),this.g)))if(this.responseType==="arraybuffer")t.arrayBuffer().then(this.Na.bind(this),this.ga.bind(this));else if(typeof v.ReadableStream<"u"&&"body"in t){if(this.j=t.body.getReader(),this.o){if(this.responseType)throw Error('responseType must be empty for "streamBinaryChunks" mode responses.');this.response=[]}else this.response=this.responseText="",this.B=new TextDecoder;Ln(this)}else t.text().then(this.Oa.bind(this),this.ga.bind(this))};function Ln(t){t.j.read().then(t.Ma.bind(t)).catch(t.ga.bind(t))}n.Ma=function(t){if(this.g){if(this.o&&t.value)this.response.push(t.value);else if(!this.o){var e=t.value?t.value:new Uint8Array(0);(e=this.B.decode(e,{stream:!t.done}))&&(this.response=this.responseText+=e)}t.done?xt(this):jt(this),this.readyState==3&&Ln(this)}},n.Oa=function(t){this.g&&(this.response=this.responseText=t,xt(this))},n.Na=function(t){this.g&&(this.response=t,xt(this))},n.ga=function(){this.g&&xt(this)};function xt(t){t.readyState=4,t.l=null,t.j=null,t.B=null,jt(t)}n.setRequestHeader=function(t,e){this.A.append(t,e)},n.getResponseHeader=function(t){return this.h&&this.h.get(t.toLowerCase())||""},n.getAllResponseHeaders=function(){if(!this.h)return"";const t=[],e=this.h.entries();for(var r=e.next();!r.done;)r=r.value,t.push(r[0]+": "+r[1]),r=e.next();return t.join(`\r
`)};function jt(t){t.onreadystatechange&&t.onreadystatechange.call(t)}Object.defineProperty(Yt.prototype,"withCredentials",{get:function(){return this.m==="include"},set:function(t){this.m=t?"include":"same-origin"}});function Hn(t){let e="";return zt(t,function(r,o){e+=o,e+=":",e+=r,e+=`\r
`}),e}function Me(t,e,r){t:{for(o in r){var o=!1;break t}o=!0}o||(r=Hn(r),typeof t=="string"?r!=null&&Dt(r):D(t,e,r))}function M(t){N.call(this),this.headers=new Map,this.L=t||null,this.h=!1,this.g=null,this.D="",this.o=0,this.l="",this.j=this.B=this.v=this.A=!1,this.m=null,this.F="",this.H=!1}T(M,N);var Sr=/^https?$/i,Ir=["POST","PUT"];n=M.prototype,n.Fa=function(t){this.H=t},n.ea=function(t,e,r,o){if(this.g)throw Error("[goog.net.XhrIo] Object is active with another request="+this.D+"; newUri="+t);e=e?e.toUpperCase():"GET",this.D=t,this.l="",this.o=0,this.A=!1,this.h=!0,this.g=this.L?this.L.g():bn.g(),this.g.onreadystatechange=S(E(this.Ca,this));try{this.B=!0,this.g.open(e,String(t),!0),this.B=!1}catch(y){Fn(this,y);return}if(t=r||"",r=new Map(this.headers),o)if(Object.getPrototypeOf(o)===Object.prototype)for(var d in o)r.set(d,o[d]);else if(typeof o.keys=="function"&&typeof o.get=="function")for(const y of o.keys())r.set(y,o.get(y));else throw Error("Unknown input type for opt_headers: "+String(o));o=Array.from(r.keys()).find(y=>y.toLowerCase()=="content-type"),d=v.FormData&&t instanceof v.FormData,!(Array.prototype.indexOf.call(Ir,e,void 0)>=0)||o||d||r.set("Content-Type","application/x-www-form-urlencoded;charset=utf-8");for(const[y,b]of r)this.g.setRequestHeader(y,b);this.F&&(this.g.responseType=this.F),"withCredentials"in this.g&&this.g.withCredentials!==this.H&&(this.g.withCredentials=this.H);try{this.m&&(clearTimeout(this.m),this.m=null),this.v=!0,this.g.send(t),this.v=!1}catch(y){Fn(this,y)}};function Fn(t,e){t.h=!1,t.g&&(t.j=!0,t.g.abort(),t.j=!1),t.l=e,t.o=5,$n(t),Zt(t)}function $n(t){t.A||(t.A=!0,L(t,"complete"),L(t,"error"))}n.abort=function(t){this.g&&this.h&&(this.h=!1,this.j=!0,this.g.abort(),this.j=!1,this.o=t||7,L(this,"complete"),L(this,"abort"),Zt(this))},n.N=function(){this.g&&(this.h&&(this.h=!1,this.j=!0,this.g.abort(),this.j=!1),Zt(this,!0)),M.Z.N.call(this)},n.Ca=function(){this.u||(this.B||this.v||this.j?Un(this):this.Xa())},n.Xa=function(){Un(this)};function Un(t){if(t.h&&typeof w<"u"){if(t.v&&et(t)==4)setTimeout(t.Ca.bind(t),0);else if(L(t,"readystatechange"),et(t)==4){t.h=!1;try{const y=t.ca();t:switch(y){case 200:case 201:case 202:case 204:case 206:case 304:case 1223:var e=!0;break t;default:e=!1}var r;if(!(r=e)){var o;if(o=y===0){let b=String(t.D).match(Mn)[1]||null;!b&&v.self&&v.self.location&&(b=v.self.location.protocol.slice(0,-1)),o=!Sr.test(b?b.toLowerCase():"")}r=o}if(r)L(t,"complete"),L(t,"success");else{t.o=6;try{var d=et(t)>2?t.g.statusText:""}catch{d=""}t.l=d+" ["+t.ca()+"]",$n(t)}}finally{Zt(t)}}}}function Zt(t,e){if(t.g){t.m&&(clearTimeout(t.m),t.m=null);const r=t.g;t.g=null,e||L(t,"ready");try{r.onreadystatechange=null}catch{}}}n.isActive=function(){return!!this.g};function et(t){return t.g?t.g.readyState:0}n.ca=function(){try{return et(this)>2?this.g.status:-1}catch{return-1}},n.la=function(){try{return this.g?this.g.responseText:""}catch{return""}},n.La=function(t){if(this.g){var e=this.g.responseText;return t&&e.indexOf(t)==0&&(e=e.substring(t.length)),nr(e)}};function Vn(t){try{if(!t.g)return null;if("response"in t.g)return t.g.response;switch(t.F){case"":case"text":return t.g.responseText;case"arraybuffer":if("mozResponseArrayBuffer"in t.g)return t.g.mozResponseArrayBuffer}return null}catch{return null}}function Cr(t){const e={};t=(t.g&&et(t)>=2&&t.g.getAllResponseHeaders()||"").split(`\r
`);for(let o=0;o<t.length;o++){if(h(t[o]))continue;var r=hr(t[o]);const d=r[0];if(r=r[1],typeof r!="string")continue;r=r.trim();const y=e[d]||[];e[d]=y,y.push(r)}Ji(e,function(o){return o.join(", ")})}n.ya=function(){return this.o},n.Ha=function(){return typeof this.l=="string"?this.l:String(this.l)};function Nt(t,e,r){return r&&r.internalChannelParams&&r.internalChannelParams[t]||e}function zn(t){this.za=0,this.i=[],this.j=new _t,this.ba=this.na=this.J=this.W=this.g=this.wa=this.G=this.H=this.u=this.U=this.o=null,this.Ya=this.V=0,this.Sa=Nt("failFast",!1,t),this.F=this.C=this.v=this.m=this.l=null,this.X=!0,this.xa=this.K=-1,this.Y=this.A=this.D=0,this.Qa=Nt("baseRetryDelayMs",5e3,t),this.Za=Nt("retryDelaySeedMs",1e4,t),this.Ta=Nt("forwardChannelMaxRetries",2,t),this.va=Nt("forwardChannelRequestTimeoutMs",2e4,t),this.ma=t&&t.xmlHttpFactory||void 0,this.Ua=t&&t.Rb||void 0,this.Aa=t&&t.useFetchStreams||!1,this.O=void 0,this.L=t&&t.supportsCrossDomainXhr||!1,this.M="",this.h=new Tn(t&&t.concurrentRequestLimit),this.Ba=new Er,this.S=t&&t.fastHandshake||!1,this.R=t&&t.encodeInitMessageHeaders||!1,this.S&&this.R&&(this.R=!1),this.Ra=t&&t.Pb||!1,t&&t.ua&&this.j.ua(),t&&t.forceLongPolling&&(this.X=!1),this.aa=!this.S&&this.X&&t&&t.detectBufferingProxy||!1,this.ia=void 0,t&&t.longPollingTimeout&&t.longPollingTimeout>0&&(this.ia=t.longPollingTimeout),this.ta=void 0,this.T=0,this.P=!1,this.ja=this.B=null}n=zn.prototype,n.ka=8,n.I=1,n.connect=function(t,e,r,o){H(0),this.W=t,this.H=e||{},r&&o!==void 0&&(this.H.OSID=r,this.H.OAID=o),this.F=this.X,this.J=Qn(this,null,this.W),te(this)};function Be(t){if(Wn(t),t.I==3){var e=t.V++,r=X(t.J);if(D(r,"SID",t.M),D(r,"RID",e),D(r,"TYPE","terminate"),Lt(t,r),e=new Z(t,t.j,e),e.M=2,e.A=Jt(X(r)),r=!1,v.navigator&&v.navigator.sendBeacon)try{r=v.navigator.sendBeacon(e.A.toString(),"")}catch{}!r&&v.Image&&(new Image().src=e.A,r=!0),r||(e.g=ti(e.j,null),e.g.ea(e.A)),e.F=Date.now(),Kt(e)}Zn(t)}function Qt(t){t.g&&(ke(t),t.g.cancel(),t.g=null)}function Wn(t){Qt(t),t.v&&(v.clearTimeout(t.v),t.v=null),ee(t),t.h.cancel(),t.m&&(typeof t.m=="number"&&v.clearTimeout(t.m),t.m=null)}function te(t){if(!_n(t.h)&&!t.m){t.m=!0;var e=t.Ea;Y||a(),z||(Y(),z=!0),f.add(e,t),t.D=0}}function Ar(t,e){return Dn(t.h)>=t.h.j-(t.m?1:0)?!1:t.m?(t.i=e.G.concat(t.i),!0):t.I==1||t.I==2||t.D>=(t.Sa?0:t.Ta)?!1:(t.m=Tt(E(t.Ea,t,e),Yn(t,t.D)),t.D++,!0)}n.Ea=function(t){if(this.m)if(this.m=null,this.I==1){if(!t){this.V=Math.floor(Math.random()*1e5),t=this.V++;const d=new Z(this,this.j,t);let y=this.o;if(this.U&&(y?(y=nn(y),sn(y,this.U)):y=this.U),this.u!==null||this.R||(d.J=y,y=null),this.S)t:{for(var e=0,r=0;r<this.i.length;r++){e:{var o=this.i[r];if("__data__"in o.map&&(o=o.map.__data__,typeof o=="string")){o=o.length;break e}o=void 0}if(o===void 0)break;if(e+=o,e>4096){e=r;break t}if(e===4096||r===this.i.length-1){e=r+1;break t}}e=1e3}else e=1e3;e=qn(this,d,e),r=X(this.J),D(r,"RID",t),D(r,"CVER",22),this.G&&D(r,"X-HTTP-Session-Id",this.G),Lt(this,r),y&&(this.R?e="headers="+Dt(Hn(y))+"&"+e:this.u&&Me(r,this.u,y)),De(this.h,d),this.Ra&&D(r,"TYPE","init"),this.S?(D(r,"$req",e),D(r,"SID","null"),d.U=!0,Ce(d,r,null)):Ce(d,r,e),this.I=2}}else this.I==3&&(t?Xn(this,t):this.i.length==0||_n(this.h)||Xn(this))};function Xn(t,e){var r;e?r=e.l:r=t.V++;const o=X(t.J);D(o,"SID",t.M),D(o,"RID",r),D(o,"AID",t.K),Lt(t,o),t.u&&t.o&&Me(o,t.u,t.o),r=new Z(t,t.j,r,t.D+1),t.u===null&&(r.J=t.o),e&&(t.i=e.G.concat(t.i)),e=qn(t,r,1e3),r.H=Math.round(t.va*.5)+Math.round(t.va*.5*Math.random()),De(t.h,r),Ce(r,o,e)}function Lt(t,e){t.H&&zt(t.H,function(r,o){D(e,o,r)}),t.l&&zt({},function(r,o){D(e,o,r)})}function qn(t,e,r){r=Math.min(t.i.length,r);const o=t.l?E(t.l.Ka,t.l,t):null;t:{var d=t.i;let A=-1;for(;;){const P=["count="+r];A==-1?r>0?(A=d[0].g,P.push("ofs="+A)):A=0:P.push("ofs="+A);let _=!0;for(let x=0;x<r;x++){var y=d[x].g;const q=d[x].map;if(y-=A,y<0)A=Math.max(0,d[x].g-100),_=!1;else try{y="req"+y+"_"||"";try{var b=q instanceof Map?q:Object.entries(q);for(const[ut,nt]of b){let it=nt;I(nt)&&(it=we(nt)),P.push(y+ut+"="+encodeURIComponent(it))}}catch(ut){throw P.push(y+"type="+encodeURIComponent("_badmap")),ut}}catch{o&&o(q)}}if(_){b=P.join("&");break t}}b=void 0}return t=t.i.splice(0,r),e.G=t,b}function Gn(t){if(!t.g&&!t.v){t.Y=1;var e=t.Da;Y||a(),z||(Y(),z=!0),f.add(e,t),t.A=0}}function Pe(t){return t.g||t.v||t.A>=3?!1:(t.Y++,t.v=Tt(E(t.Da,t),Yn(t,t.A)),t.A++,!0)}n.Da=function(){if(this.v=null,Kn(this),this.aa&&!(this.P||this.g==null||this.T<=0)){var t=4*this.T;this.j.info("BP detection timer enabled: "+t),this.B=Tt(E(this.Wa,this),t)}},n.Wa=function(){this.B&&(this.B=null,this.j.info("BP detection timeout reached."),this.j.info("Buffering proxy detected and switch to long-polling!"),this.F=!1,this.P=!0,H(10),Qt(this),Kn(this))};function ke(t){t.B!=null&&(v.clearTimeout(t.B),t.B=null)}function Kn(t){t.g=new Z(t,t.j,"rpc",t.Y),t.u===null&&(t.g.J=t.o),t.g.P=0;var e=X(t.na);D(e,"RID","rpc"),D(e,"SID",t.M),D(e,"AID",t.K),D(e,"CI",t.F?"0":"1"),!t.F&&t.ia&&D(e,"TO",t.ia),D(e,"TYPE","xmlhttp"),Lt(t,e),t.u&&t.o&&Me(e,t.u,t.o),t.O&&(t.g.H=t.O);var r=t.g;t=t.ba,r.M=1,r.A=Jt(X(e)),r.u=null,r.R=!0,In(r,t)}n.Va=function(){this.C!=null&&(this.C=null,Qt(this),Pe(this),H(19))};function ee(t){t.C!=null&&(v.clearTimeout(t.C),t.C=null)}function Jn(t,e){var r=null;if(t.g==e){ee(t),ke(t),t.g=null;var o=2}else if(_e(t.h,e))r=e.G,On(t.h,e),o=1;else return;if(t.I!=0){if(e.o)if(o==1){r=e.u?e.u.length:0,e=Date.now()-e.F;var d=t.D;o=qt(),L(o,new vn(o,r)),te(t)}else Gn(t);else if(d=e.m,d==3||d==0&&e.X>0||!(o==1&&Ar(t,e)||o==2&&Pe(t)))switch(r&&r.length>0&&(e=t.h,e.i=e.i.concat(r)),d){case 1:lt(t,5);break;case 4:lt(t,10);break;case 3:lt(t,6);break;default:lt(t,2)}}}function Yn(t,e){let r=t.Qa+Math.floor(Math.random()*t.Za);return t.isActive()||(r*=2),r*e}function lt(t,e){if(t.j.info("Error code "+e),e==2){var r=E(t.bb,t),o=t.Ua;const d=!o;o=new Q(o||"//www.google.com/images/cleardot.gif"),v.location&&v.location.protocol=="http"||Rt(o,"https"),Jt(o),d?wr(o.toString(),r):br(o.toString(),r)}else H(2);t.I=0,t.l&&t.l.pa(e),Zn(t),Wn(t)}n.bb=function(t){t?(this.j.info("Successfully pinged google.com"),H(2)):(this.j.info("Failed to ping google.com"),H(1))};function Zn(t){if(t.I=0,t.ja=[],t.l){const e=Rn(t.h);(e.length!=0||t.i.length!=0)&&(B(t.ja,e),B(t.ja,t.i),t.h.i.length=0,k(t.i),t.i.length=0),t.l.oa()}}function Qn(t,e,r){var o=r instanceof Q?X(r):new Q(r);if(o.g!="")e&&(o.g=e+"."+o.g),Mt(o,o.u);else{var d=v.location;o=d.protocol,e=e?e+"."+d.hostname:d.hostname,d=+d.port;const y=new Q(null);o&&Rt(y,o),e&&(y.g=e),d&&Mt(y,d),r&&(y.h=r),o=y}return r=t.G,e=t.wa,r&&e&&D(o,r,e),D(o,"VER",t.ka),Lt(t,o),o}function ti(t,e,r){if(e&&!t.L)throw Error("Can't create secondary domain capable XhrIo object.");return e=t.Aa&&!t.ma?new M(new Re({ab:r})):new M(t.ma),e.Fa(t.L),e}n.isActive=function(){return!!this.l&&this.l.isActive(this)};function ei(){}n=ei.prototype,n.ra=function(){},n.qa=function(){},n.pa=function(){},n.oa=function(){},n.isActive=function(){return!0},n.Ka=function(){};function ne(){}ne.prototype.g=function(t,e){return new U(t,e)};function U(t,e){N.call(this),this.g=new zn(e),this.l=t,this.h=e&&e.messageUrlParams||null,t=e&&e.messageHeaders||null,e&&e.clientProtocolHeaderRequired&&(t?t["X-Client-Protocol"]="webchannel":t={"X-Client-Protocol":"webchannel"}),this.g.o=t,t=e&&e.initMessageHeaders||null,e&&e.messageContentType&&(t?t["X-WebChannel-Content-Type"]=e.messageContentType:t={"X-WebChannel-Content-Type":e.messageContentType}),e&&e.sa&&(t?t["X-WebChannel-Client-Profile"]=e.sa:t={"X-WebChannel-Client-Profile":e.sa}),this.g.U=t,(t=e&&e.Qb)&&!h(t)&&(this.g.u=t),this.A=e&&e.supportsCrossDomainXhr||!1,this.v=e&&e.sendRawJson||!1,(e=e&&e.httpSessionIdParam)&&!h(e)&&(this.g.G=e,t=this.h,t!==null&&e in t&&(t=this.h,e in t&&delete t[e])),this.j=new bt(this)}T(U,N),U.prototype.m=function(){this.g.l=this.j,this.A&&(this.g.L=!0),this.g.connect(this.l,this.h||void 0)},U.prototype.close=function(){Be(this.g)},U.prototype.o=function(t){var e=this.g;if(typeof t=="string"){var r={};r.__data__=t,t=r}else this.v&&(r={},r.__data__=we(t),t=r);e.i.push(new ur(e.Ya++,t)),e.I==3&&te(e)},U.prototype.N=function(){this.g.l=null,delete this.j,Be(this.g),delete this.g,U.Z.N.call(this)};function ni(t){be.call(this),t.__headers__&&(this.headers=t.__headers__,this.statusCode=t.__status__,delete t.__headers__,delete t.__status__);var e=t.__sm__;if(e){t:{for(const r in e){t=r;break t}t=void 0}(this.i=t)&&(t=this.i,e=e!==null&&t in e?e[t]:void 0),this.data=e}else this.data=t}T(ni,be);function ii(){Ee.call(this),this.status=1}T(ii,Ee);function bt(t){this.g=t}T(bt,ei),bt.prototype.ra=function(){L(this.g,"a")},bt.prototype.qa=function(t){L(this.g,new ni(t))},bt.prototype.pa=function(t){L(this.g,new ii)},bt.prototype.oa=function(){L(this.g,"b")},ne.prototype.createWebChannel=ne.prototype.g,U.prototype.send=U.prototype.o,U.prototype.open=U.prototype.m,U.prototype.close=U.prototype.close,bo=function(){return new ne},wo=function(){return qt()},vo=at,yo={jb:0,mb:1,nb:2,Hb:3,Mb:4,Jb:5,Kb:6,Ib:7,Gb:8,Lb:9,PROXY:10,NOPROXY:11,Eb:12,Ab:13,Bb:14,zb:15,Cb:16,Db:17,fb:18,eb:19,gb:20},Gt.NO_ERROR=0,Gt.TIMEOUT=8,Gt.HTTP_ERROR=6,mo=Gt,wn.COMPLETE="complete",go=wn,gn.EventType=Ct,Ct.OPEN="a",Ct.CLOSE="b",Ct.ERROR="c",Ct.MESSAGE="d",N.prototype.listen=N.prototype.J,po=gn,M.prototype.listenOnce=M.prototype.K,M.prototype.getLastError=M.prototype.Ha,M.prototype.getLastErrorCode=M.prototype.ya,M.prototype.getStatus=M.prototype.ca,M.prototype.getResponseJson=M.prototype.La,M.prototype.getResponseText=M.prototype.la,M.prototype.send=M.prototype.ea,M.prototype.setWithCredentials=M.prototype.Fa,fo=M}).apply(typeof re<"u"?re:typeof self<"u"?self:typeof window<"u"?window:{});const Ri="@firebase/installations",Ze="0.6.19";/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Mi=1e4,Bi=`w:${Ze}`,Pi="FIS_v2",Eo="https://firebaseinstallations.googleapis.com/v1",So=3600*1e3,Io="installations",Co="Installations";/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Ao={"missing-app-config-values":'Missing App configuration value: "{$valueName}"',"not-registered":"Firebase Installation is not registered.","installation-not-found":"Firebase Installation not found.","request-failed":'{$requestName} request failed with error "{$serverCode} {$serverStatus}: {$serverMessage}"',"app-offline":"Could not process request. Application offline.","delete-pending-registration":"Can't delete installation while there is a pending registration request."},dt=new Je(Io,Co,Ao);function ki(n){return n instanceof yt&&n.code.includes("request-failed")}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function xi({projectId:n}){return`${Eo}/projects/${n}/installations`}function ji(n){return{token:n.token,requestStatus:2,expiresIn:_o(n.expiresIn),creationTime:Date.now()}}async function Ni(n,i){const c=(await i.json()).error;return dt.create("request-failed",{requestName:n,serverCode:c.code,serverMessage:c.message,serverStatus:c.status})}function Li({apiKey:n}){return new Headers({"Content-Type":"application/json",Accept:"application/json","x-goog-api-key":n})}function To(n,{refreshToken:i}){const s=Li(n);return s.append("Authorization",Do(i)),s}async function Hi(n){const i=await n();return i.status>=500&&i.status<600?n():i}function _o(n){return Number(n.replace("s","000"))}function Do(n){return`${Pi} ${n}`}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */async function Oo({appConfig:n,heartbeatServiceProvider:i},{fid:s}){const c=xi(n),g=Li(n),w=i.getImmediate({optional:!0});if(w){const E=await w.getHeartbeatsHeader();E&&g.append("x-firebase-client",E)}const v={fid:s,authVersion:Pi,appId:n.appId,sdkVersion:Bi},I={method:"POST",headers:g,body:JSON.stringify(v)},C=await Hi(()=>fetch(c,I));if(C.ok){const E=await C.json();return{fid:E.fid||s,registrationStatus:2,refreshToken:E.refreshToken,authToken:ji(E.authToken)}}else throw await Ni("Create Installation",C)}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Fi(n){return new Promise(i=>{setTimeout(i,n)})}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function Ro(n){return btoa(String.fromCharCode(...n)).replace(/\+/g,"-").replace(/\//g,"_")}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Mo=/^[cdef][\w-]{21}$/,Ke="";function Bo(){try{const n=new Uint8Array(17);(self.crypto||self.msCrypto).getRandomValues(n),n[0]=112+n[0]%16;const s=Po(n);return Mo.test(s)?s:Ke}catch{return Ke}}function Po(n){return Ro(n).substr(0,22)}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function le(n){return`${n.appName}!${n.appId}`}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const $i=new Map;function Ui(n,i){const s=le(n);Vi(s,i),ko(s,i)}function Vi(n,i){const s=$i.get(n);if(s)for(const c of s)c(i)}function ko(n,i){const s=xo();s&&s.postMessage({key:n,fid:i}),jo()}let pt=null;function xo(){return!pt&&"BroadcastChannel"in self&&(pt=new BroadcastChannel("[Firebase] FID Change"),pt.onmessage=n=>{Vi(n.data.key,n.data.fid)}),pt}function jo(){$i.size===0&&pt&&(pt.close(),pt=null)}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const No="firebase-installations-database",Lo=1,mt="firebase-installations-store";let $e=null;function Qe(){return $e||($e=Ai(No,Lo,{upgrade:(n,i)=>{switch(i){case 0:n.createObjectStore(mt)}}})),$e}async function ae(n,i){const s=le(n),g=(await Qe()).transaction(mt,"readwrite"),w=g.objectStore(mt),v=await w.get(s);return await w.put(i,s),await g.done,(!v||v.fid!==i.fid)&&Ui(n,i.fid),i}async function zi(n){const i=le(n),c=(await Qe()).transaction(mt,"readwrite");await c.objectStore(mt).delete(i),await c.done}async function ue(n,i){const s=le(n),g=(await Qe()).transaction(mt,"readwrite"),w=g.objectStore(mt),v=await w.get(s),I=i(v);return I===void 0?await w.delete(s):await w.put(I,s),await g.done,I&&(!v||v.fid!==I.fid)&&Ui(n,I.fid),I}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */async function tn(n){let i;const s=await ue(n.appConfig,c=>{const g=Ho(c),w=Fo(n,g);return i=w.registrationPromise,w.installationEntry});return s.fid===Ke?{installationEntry:await i}:{installationEntry:s,registrationPromise:i}}function Ho(n){const i=n||{fid:Bo(),registrationStatus:0};return Wi(i)}function Fo(n,i){if(i.registrationStatus===0){if(!navigator.onLine){const g=Promise.reject(dt.create("app-offline"));return{installationEntry:i,registrationPromise:g}}const s={fid:i.fid,registrationStatus:1,registrationTime:Date.now()},c=$o(n,s);return{installationEntry:s,registrationPromise:c}}else return i.registrationStatus===1?{installationEntry:i,registrationPromise:Uo(n)}:{installationEntry:i}}async function $o(n,i){try{const s=await Oo(n,i);return ae(n.appConfig,s)}catch(s){throw ki(s)&&s.customData.serverCode===409?await zi(n.appConfig):await ae(n.appConfig,{fid:i.fid,registrationStatus:0}),s}}async function Uo(n){let i=await mi(n.appConfig);for(;i.registrationStatus===1;)await Fi(100),i=await mi(n.appConfig);if(i.registrationStatus===0){const{installationEntry:s,registrationPromise:c}=await tn(n);return c||s}return i}function mi(n){return ue(n,i=>{if(!i)throw dt.create("installation-not-found");return Wi(i)})}function Wi(n){return Vo(n)?{fid:n.fid,registrationStatus:0}:n}function Vo(n){return n.registrationStatus===1&&n.registrationTime+Mi<Date.now()}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */async function zo({appConfig:n,heartbeatServiceProvider:i},s){const c=Wo(n,s),g=To(n,s),w=i.getImmediate({optional:!0});if(w){const E=await w.getHeartbeatsHeader();E&&g.append("x-firebase-client",E)}const v={installation:{sdkVersion:Bi,appId:n.appId}},I={method:"POST",headers:g,body:JSON.stringify(v)},C=await Hi(()=>fetch(c,I));if(C.ok){const E=await C.json();return ji(E)}else throw await Ni("Generate Auth Token",C)}function Wo(n,{fid:i}){return`${xi(n)}/${i}/authTokens:generate`}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */async function en(n,i=!1){let s;const c=await ue(n.appConfig,w=>{if(!Xi(w))throw dt.create("not-registered");const v=w.authToken;if(!i&&Go(v))return w;if(v.requestStatus===1)return s=Xo(n,i),w;{if(!navigator.onLine)throw dt.create("app-offline");const I=Jo(w);return s=qo(n,I),I}});return s?await s:c.authToken}async function Xo(n,i){let s=await yi(n.appConfig);for(;s.authToken.requestStatus===1;)await Fi(100),s=await yi(n.appConfig);const c=s.authToken;return c.requestStatus===0?en(n,i):c}function yi(n){return ue(n,i=>{if(!Xi(i))throw dt.create("not-registered");const s=i.authToken;return Yo(s)?{...i,authToken:{requestStatus:0}}:i})}async function qo(n,i){try{const s=await zo(n,i),c={...i,authToken:s};return await ae(n.appConfig,c),s}catch(s){if(ki(s)&&(s.customData.serverCode===401||s.customData.serverCode===404))await zi(n.appConfig);else{const c={...i,authToken:{requestStatus:0}};await ae(n.appConfig,c)}throw s}}function Xi(n){return n!==void 0&&n.registrationStatus===2}function Go(n){return n.requestStatus===2&&!Ko(n)}function Ko(n){const i=Date.now();return i<n.creationTime||n.creationTime+n.expiresIn<i+So}function Jo(n){const i={requestStatus:1,requestTime:Date.now()};return{...n,authToken:i}}function Yo(n){return n.requestStatus===1&&n.requestTime+Mi<Date.now()}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */async function Zo(n){const i=n,{installationEntry:s,registrationPromise:c}=await tn(i);return c?c.catch(console.error):en(i).catch(console.error),s.fid}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */async function Qo(n,i=!1){const s=n;return await ta(s),(await en(s,i)).token}async function ta(n){const{registrationPromise:i}=await tn(n);i&&await i}/**
 * @license
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */function ea(n){if(!n||!n.options)throw Ue("App Configuration");if(!n.name)throw Ue("App Name");const i=["projectId","apiKey","appId"];for(const s of i)if(!n.options[s])throw Ue(s);return{appName:n.name,projectId:n.options.projectId,apiKey:n.options.apiKey,appId:n.options.appId}}function Ue(n){return dt.create("missing-app-config-values",{valueName:n})}/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const qi="installations",na="installations-internal",ia=n=>{const i=n.getProvider("app").getImmediate(),s=ea(i),c=ce(i,"heartbeat");return{app:i,appConfig:s,heartbeatServiceProvider:c,_delete:()=>Promise.resolve()}},ra=n=>{const i=n.getProvider("app").getImmediate(),s=ce(i,qi).getImmediate();return{getId:()=>Zo(s),getToken:g=>Qo(s,g)}};function sa(){St(new Et(qi,ia,"PUBLIC")),St(new Et(na,ra,"PRIVATE"))}sa();gt(Ri,Ze);gt(Ri,Ze,"esm2020");var oa="firebase",aa="12.9.0";/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */gt(oa,aa,"app");const Ra=Object.freeze(Object.defineProperty({__proto__:null,FirebaseError:yt,SDK_VERSION:Zs,_DEFAULT_ENTRY_NAME:Ft,_addComponent:Ge,_apps:$t,_components:oe,_getProvider:ce,_isFirebaseServerApp:Ks,_registerComponent:St,_removeServiceInstance:Gs,_serverApps:Ti,getApp:Qs,initializeApp:_i,registerVersion:gt},Symbol.toStringTag,{value:"Module"}));export{ha as $,Ur as A,Da as B,Et as C,Aa as D,vo as E,yt as F,Ta as G,Ca as H,lo as I,la as J,jr as K,as as L,uo as M,va as N,Ia as O,Ve as P,ga as Q,ya as R,yo as S,da as T,_a as U,Sa as V,po as W,fo as X,Nr as Y,wi as Z,ce as _,O as a,Ra as a0,Qs as b,fa as c,ze as d,ca as e,Gs as f,Oa as g,Br as h,Lr as i,$r as j,Ei as k,wa as l,wo as m,go as n,mo as o,ua as p,bo as q,ba as r,Ks as s,St as t,pa as u,gt as v,Zs as w,Je as x,ma as y,Ea as z};
