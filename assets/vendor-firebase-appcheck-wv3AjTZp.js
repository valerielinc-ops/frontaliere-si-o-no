import{V as oe,x as ie,_ as P,g as se,b as ae,Y as g,L as ce,h as le,B as ue,j as F,Z as he,t as H,C as O,v as de}from"./vendor-firebase-core-D5lXZ75A.js";/**
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
 */const v=new Map,z={activated:!1,tokenObservers:[]},fe={initialized:!1,enabled:!1};function c(e){return v.get(e)||{...z}}function pe(e,t){return v.set(e,t),v.get(e)}function b(){return fe}/**
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
 */const y="https://content-firebaseappcheck.googleapis.com/v1",ge="exchangeRecaptchaV3Token",ke="exchangeRecaptchaEnterpriseToken",Te="exchangeDebugToken",B={RETRIAL_MIN_WAIT:30*1e3,RETRIAL_MAX_WAIT:960*1e3},me=1440*60*1e3;/**
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
 */class Ee{constructor(t,r,n,o,i){if(this.operation=t,this.retryPolicy=r,this.getWaitDuration=n,this.lowerBound=o,this.upperBound=i,this.pending=null,this.nextErrorWaitInterval=o,o>i)throw new Error("Proactive refresh lower bound greater than upper bound!")}start(){this.nextErrorWaitInterval=this.lowerBound,this.process(!0).catch(()=>{})}stop(){this.pending&&(this.pending.reject("cancelled"),this.pending=null)}isRunning(){return!!this.pending}async process(t){this.stop();try{this.pending=new g,this.pending.promise.catch(r=>{}),await we(this.getNextRun(t)),this.pending.resolve(),await this.pending.promise,this.pending=new g,this.pending.promise.catch(r=>{}),await this.operation(),this.pending.resolve(),await this.pending.promise,this.process(!0).catch(()=>{})}catch(r){this.retryPolicy(r)?this.process(!1).catch(()=>{}):this.stop()}}getNextRun(t){if(t)return this.nextErrorWaitInterval=this.lowerBound,this.getWaitDuration();{const r=this.nextErrorWaitInterval;return this.nextErrorWaitInterval*=2,this.nextErrorWaitInterval>this.upperBound&&(this.nextErrorWaitInterval=this.upperBound),r}}}function we(e){return new Promise(t=>{setTimeout(t,e)})}/**
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
 */const Ae={"already-initialized":"You have already called initializeAppCheck() for FirebaseApp {$appName} with different options. To avoid this error, call initializeAppCheck() with the same options as when it was originally called. This will return the already initialized instance.","use-before-activation":"App Check is being used before initializeAppCheck() is called for FirebaseApp {$appName}. Call initializeAppCheck() before instantiating other Firebase services.","fetch-network-error":"Fetch failed to connect to a network. Check Internet connection. Original error: {$originalErrorMessage}.","fetch-parse-error":"Fetch client could not parse response. Original error: {$originalErrorMessage}.","fetch-status-error":"Fetch server returned an HTTP error status. HTTP status: {$httpStatus}.","storage-open":"Error thrown when opening storage. Original error: {$originalErrorMessage}.","storage-get":"Error thrown when reading from storage. Original error: {$originalErrorMessage}.","storage-set":"Error thrown when writing to storage. Original error: {$originalErrorMessage}.","recaptcha-error":"ReCAPTCHA error.","initial-throttle":"{$httpStatus} error. Attempts allowed again after {$time}",throttled:"Requests throttled due to previous {$httpStatus} error. Attempts allowed again after {$time}"},u=new ie("appCheck","AppCheck",Ae);/**
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
 */function E(e=!1){var t;return e?(t=self.grecaptcha)==null?void 0:t.enterprise:self.grecaptcha}function D(e){if(!c(e).activated)throw u.create("use-before-activation",{appName:e.name})}function S(e){const t=Math.round(e/1e3),r=Math.floor(t/(3600*24)),n=Math.floor((t-r*3600*24)/3600),o=Math.floor((t-r*3600*24-n*3600)/60),i=t-r*3600*24-n*3600-o*60;let s="";return r&&(s+=T(r)+"d:"),n&&(s+=T(n)+"h:"),s+=T(o)+"m:"+T(i)+"s",s}function T(e){return e===0?"00":e>=10?e.toString():"0"+e}/**
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
 */async function _({url:e,body:t},r){const n={"Content-Type":"application/json"},o=r.getImmediate({optional:!0});if(o){const d=await o.getHeartbeatsHeader();d&&(n["X-Firebase-Client"]=d)}const i={method:"POST",body:JSON.stringify(t),headers:n};let s;try{s=await fetch(e,i)}catch(d){throw u.create("fetch-network-error",{originalErrorMessage:d==null?void 0:d.message})}if(s.status!==200)throw u.create("fetch-status-error",{httpStatus:s.status});let h;try{h=await s.json()}catch(d){throw u.create("fetch-parse-error",{originalErrorMessage:d==null?void 0:d.message})}const l=h.ttl.match(/^([\d.]+)(s)$/);if(!l||!l[2]||isNaN(Number(l[1])))throw u.create("fetch-parse-error",{originalErrorMessage:`ttl field (timeToLive) is not in standard Protobuf Duration format: ${h.ttl}`});const a=Number(l[1])*1e3,$=Date.now();return{token:h.token,expireTimeMillis:$+a,issuedAtTimeMillis:$}}function be(e,t){const{projectId:r,appId:n,apiKey:o}=e.options;return{url:`${y}/projects/${r}/apps/${n}:${ge}?key=${o}`,body:{recaptcha_v3_token:t}}}function _e(e,t){const{projectId:r,appId:n,apiKey:o}=e.options;return{url:`${y}/projects/${r}/apps/${n}:${ke}?key=${o}`,body:{recaptcha_enterprise_token:t}}}function q(e,t){const{projectId:r,appId:n,apiKey:o}=e.options;return{url:`${y}/projects/${r}/apps/${n}:${Te}?key=${o}`,body:{debug_token:t}}}/**
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
 */const Ce="firebase-app-check-database",Re=1,k="firebase-app-check-store",U="debug-token";let m=null;function W(){return m||(m=new Promise((e,t)=>{try{const r=indexedDB.open(Ce,Re);r.onsuccess=n=>{e(n.target.result)},r.onerror=n=>{var o;t(u.create("storage-open",{originalErrorMessage:(o=n.target.error)==null?void 0:o.message}))},r.onupgradeneeded=n=>{const o=n.target.result;switch(n.oldVersion){case 0:o.createObjectStore(k,{keyPath:"compositeKey"})}}}catch(r){t(u.create("storage-open",{originalErrorMessage:r==null?void 0:r.message}))}}),m)}function ve(e){return G(X(e))}function Pe(e,t){return j(X(e),t)}function ye(e){return j(U,e)}function De(){return G(U)}async function j(e,t){const n=(await W()).transaction(k,"readwrite"),i=n.objectStore(k).put({compositeKey:e,value:t});return new Promise((s,h)=>{i.onsuccess=l=>{s()},n.onerror=l=>{var a;h(u.create("storage-set",{originalErrorMessage:(a=l.target.error)==null?void 0:a.message}))}})}async function G(e){const r=(await W()).transaction(k,"readonly"),o=r.objectStore(k).get(e);return new Promise((i,s)=>{o.onsuccess=h=>{const l=h.target.result;i(l?l.value:void 0)},r.onerror=h=>{var l;s(u.create("storage-get",{originalErrorMessage:(l=h.target.error)==null?void 0:l.message}))}})}function X(e){return`${e.options.appId}-${e.name}`}/**
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
 */const f=new ce("@firebase/app-check");/**
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
 */async function Se(e){if(F()){let t;try{t=await ve(e)}catch(r){f.warn(`Failed to read token from IndexedDB. Error: ${r}`)}return t}}function C(e,t){return F()?Pe(e,t).catch(r=>{f.warn(`Failed to write token to IndexedDB. Error: ${r}`)}):Promise.resolve()}async function Ie(){let e;try{e=await De()}catch{}if(e)return e;{const t=crypto.randomUUID();return ye(t).catch(r=>f.warn(`Failed to persist debug token to IndexedDB. Error: ${r}`)),t}}/**
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
 */function I(){return b().enabled}async function M(){const e=b();if(e.enabled&&e.token)return e.token.promise;throw Error(`
            Can't get debug token in production mode.
        `)}function Me(){const e=le(),t=b();if(t.initialized=!0,typeof e.FIREBASE_APPCHECK_DEBUG_TOKEN!="string"&&e.FIREBASE_APPCHECK_DEBUG_TOKEN!==!0)return;t.enabled=!0;const r=new g;t.token=r,typeof e.FIREBASE_APPCHECK_DEBUG_TOKEN=="string"?r.resolve(e.FIREBASE_APPCHECK_DEBUG_TOKEN):r.resolve(Ie())}/**
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
 */const xe={error:"UNKNOWN_ERROR"};function Ne(e){return he.encodeString(JSON.stringify(e),!1)}async function w(e,t=!1,r=!1){const n=e.app;D(n);const o=c(n);let i=o.token,s;if(i&&!p(i)&&(o.token=void 0,i=void 0),!i){const a=await o.cachedTokenPromise;a&&(p(a)?i=a:await C(n,void 0))}if(!t&&i&&p(i))return{token:i.token};let h=!1;if(I())try{o.exchangeTokenPromise||(o.exchangeTokenPromise=_(q(n,await M()),e.heartbeatServiceProvider).finally(()=>{o.exchangeTokenPromise=void 0}),h=!0);const a=await o.exchangeTokenPromise;return await C(n,a),o.token=a,{token:a.token}}catch(a){return a.code==="appCheck/throttled"||a.code==="appCheck/initial-throttle"?f.warn(a.message):r&&f.error(a),R(a)}try{o.exchangeTokenPromise||(o.exchangeTokenPromise=o.provider.getToken().finally(()=>{o.exchangeTokenPromise=void 0}),h=!0),i=await c(n).exchangeTokenPromise}catch(a){a.code==="appCheck/throttled"||a.code==="appCheck/initial-throttle"?f.warn(a.message):r&&f.error(a),s=a}let l;return i?s?p(i)?l={token:i.token,internalError:s}:l=R(s):(l={token:i.token},o.token=i,await C(n,i)):l=R(s),h&&Y(n,l),l}async function V(e){const t=e.app;D(t);const{provider:r}=c(t);if(I()){const n=await M(),{token:o}=await _(q(t,n),e.heartbeatServiceProvider);return{token:o}}else{const{token:n}=await r.getToken();return{token:n}}}function x(e,t,r,n){const{app:o}=e,i=c(o),s={next:r,error:n,type:t};if(i.tokenObservers=[...i.tokenObservers,s],i.token&&p(i.token)){const h=i.token;Promise.resolve().then(()=>{r({token:h.token}),K(e)}).catch(()=>{})}i.cachedTokenPromise.then(()=>K(e))}function N(e,t){const r=c(e),n=r.tokenObservers.filter(o=>o.next!==t);n.length===0&&r.tokenRefresher&&r.tokenRefresher.isRunning()&&r.tokenRefresher.stop(),r.tokenObservers=n}function K(e){const{app:t}=e,r=c(t);let n=r.tokenRefresher;n||(n=$e(e),r.tokenRefresher=n),!n.isRunning()&&r.isTokenAutoRefreshEnabled&&n.start()}function $e(e){const{app:t}=e;return new Ee(async()=>{const r=c(t);let n;if(r.token?n=await w(e,!0):n=await w(e),n.error)throw n.error;if(n.internalError)throw n.internalError},()=>!0,()=>{const r=c(t);if(r.token){let n=r.token.issuedAtTimeMillis+(r.token.expireTimeMillis-r.token.issuedAtTimeMillis)*.5+3e5;const o=r.token.expireTimeMillis-300*1e3;return n=Math.min(n,o),Math.max(0,n-Date.now())}else return 0},B.RETRIAL_MIN_WAIT,B.RETRIAL_MAX_WAIT)}function Y(e,t){const r=c(e).tokenObservers;for(const n of r)try{n.type==="EXTERNAL"&&t.error!=null?n.error(t.error):n.next(t)}catch{}}function p(e){return e.expireTimeMillis-Date.now()>0}function R(e){return{token:Ne(xe),error:e}}/**
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
 */class He{constructor(t,r){this.app=t,this.heartbeatServiceProvider=r}_delete(){const{tokenObservers:t}=c(this.app);for(const r of t)N(this.app,r.next);return Promise.resolve()}}function Oe(e,t){return new He(e,t)}function Be(e){return{getToken:t=>w(e,t),getLimitedUseToken:()=>V(e),addTokenListener:t=>x(e,"INTERNAL",t),removeTokenListener:t=>N(e.app,t)}}const Ke="@firebase/app-check",Le="0.11.0";/**
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
 */const Fe="https://www.google.com/recaptcha/api.js",ze="https://www.google.com/recaptcha/enterprise.js";function qe(e,t){const r=new g,n=c(e);n.reCAPTCHAState={initialized:r};const o=J(e),i=E(!1);return i?A(e,t,i,o,r):je(()=>{const s=E(!1);if(!s)throw new Error("no recaptcha");A(e,t,s,o,r)}),r.promise}function Ue(e,t){const r=new g,n=c(e);n.reCAPTCHAState={initialized:r};const o=J(e),i=E(!0);return i?A(e,t,i,o,r):Ge(()=>{const s=E(!0);if(!s)throw new Error("no recaptcha");A(e,t,s,o,r)}),r.promise}function A(e,t,r,n,o){r.ready(()=>{We(e,t,r,n),o.resolve(r)})}function J(e){const t=`fire_app_check_${e.name}`,r=document.createElement("div");return r.id=t,r.style.display="none",document.body.appendChild(r),t}async function Z(e){D(e);const r=await c(e).reCAPTCHAState.initialized.promise;return new Promise((n,o)=>{const i=c(e).reCAPTCHAState;r.ready(()=>{n(r.execute(i.widgetId,{action:"fire_app_check"}))})})}function We(e,t,r,n){const o=r.render(n,{sitekey:t,size:"invisible",callback:()=>{c(e).reCAPTCHAState.succeeded=!0},"error-callback":()=>{c(e).reCAPTCHAState.succeeded=!1}}),i=c(e);i.reCAPTCHAState={...i.reCAPTCHAState,widgetId:o}}function je(e){const t=document.createElement("script");t.src=Fe,t.onload=e,document.head.appendChild(t)}function Ge(e){const t=document.createElement("script");t.src=ze,t.onload=e,document.head.appendChild(t)}/**
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
 */class Q{constructor(t){this._siteKey=t,this._throttleData=null}async getToken(){var n,o,i;ne(this._throttleData);const t=await Z(this._app).catch(s=>{throw u.create("recaptcha-error")});if(!((n=c(this._app).reCAPTCHAState)!=null&&n.succeeded))throw u.create("recaptcha-error");let r;try{r=await _(be(this._app,t),this._heartbeatServiceProvider)}catch(s){throw(o=s.code)!=null&&o.includes("fetch-status-error")?(this._throttleData=re(Number((i=s.customData)==null?void 0:i.httpStatus),this._throttleData),u.create("initial-throttle",{time:S(this._throttleData.allowRequestsAfter-Date.now()),httpStatus:this._throttleData.httpStatus})):s}return this._throttleData=null,r}initialize(t){this._app=t,this._heartbeatServiceProvider=P(t,"heartbeat"),qe(t,this._siteKey).catch(()=>{})}isEqual(t){return t instanceof Q?this._siteKey===t._siteKey:!1}}class ee{constructor(t){this._siteKey=t,this._throttleData=null}async getToken(){var n,o,i;ne(this._throttleData);const t=await Z(this._app).catch(s=>{throw u.create("recaptcha-error")});if(!((n=c(this._app).reCAPTCHAState)!=null&&n.succeeded))throw u.create("recaptcha-error");let r;try{r=await _(_e(this._app,t),this._heartbeatServiceProvider)}catch(s){throw(o=s.code)!=null&&o.includes("fetch-status-error")?(this._throttleData=re(Number((i=s.customData)==null?void 0:i.httpStatus),this._throttleData),u.create("initial-throttle",{time:S(this._throttleData.allowRequestsAfter-Date.now()),httpStatus:this._throttleData.httpStatus})):s}return this._throttleData=null,r}initialize(t){this._app=t,this._heartbeatServiceProvider=P(t,"heartbeat"),Ue(t,this._siteKey).catch(()=>{})}isEqual(t){return t instanceof ee?this._siteKey===t._siteKey:!1}}class te{constructor(t){this._customProviderOptions=t}async getToken(){const t=await this._customProviderOptions.getToken(),r=oe(t.token),n=r!==null&&r<Date.now()&&r>0?r*1e3:Date.now();return{...t,issuedAtTimeMillis:n}}initialize(t){this._app=t}isEqual(t){return t instanceof te?this._customProviderOptions.getToken.toString()===t._customProviderOptions.getToken.toString():!1}}function re(e,t){if(e===404||e===403)return{backoffCount:1,allowRequestsAfter:Date.now()+me,httpStatus:e};{const r=t?t.backoffCount:0,n=ue(r,1e3,2);return{backoffCount:r+1,allowRequestsAfter:Date.now()+n,httpStatus:e}}}function ne(e){if(e&&Date.now()-e.allowRequestsAfter<=0)throw u.create("throttled",{time:S(e.allowRequestsAfter-Date.now()),httpStatus:e.httpStatus})}/**
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
 */function Ze(e=ae(),t){e=se(e);const r=P(e,"app-check");if(b().initialized||Me(),I()&&M().then(o=>console.log(`App Check debug token: ${o}. You will need to add it to your app's App Check settings in the Firebase console for it to work.`)),r.isInitialized()){const o=r.getImmediate(),i=r.getOptions();if(i.isTokenAutoRefreshEnabled===t.isTokenAutoRefreshEnabled&&i.provider.isEqual(t.provider))return o;throw u.create("already-initialized",{appName:e.name})}const n=r.initialize({options:t});return Xe(e,t.provider,t.isTokenAutoRefreshEnabled),c(e).isTokenAutoRefreshEnabled&&x(n,"INTERNAL",()=>{}),n}function Xe(e,t,r=!1){const n=pe(e,{...z});n.activated=!0,n.provider=t,n.cachedTokenPromise=Se(e).then(o=>(o&&p(o)&&(n.token=o,Y(e,{token:o.token})),o)),n.isTokenAutoRefreshEnabled=r&&e.automaticDataCollectionEnabled,!e.automaticDataCollectionEnabled&&r&&f.warn("`isTokenAutoRefreshEnabled` is true but `automaticDataCollectionEnabled` was set to false during `initializeApp()`. This blocks automatic token refresh."),n.provider.initialize(e)}function Qe(e,t){const r=e.app,n=c(r);n.tokenRefresher&&(t===!0?n.tokenRefresher.start():n.tokenRefresher.stop()),n.isTokenAutoRefreshEnabled=t}async function et(e,t){const r=await w(e,t);if(r.error)throw r.error;if(r.internalError)throw r.internalError;return{token:r.token}}function tt(e){return V(e)}function rt(e,t,r,n){let o=()=>{},i=()=>{};return t.next!=null?o=t.next.bind(t):o=t,t.error!=null?i=t.error.bind(t):r&&(i=r),x(e,"EXTERNAL",o,i),()=>N(e.app,o)}const Ve="app-check",L="app-check-internal";function Ye(){H(new O(Ve,e=>{const t=e.getProvider("app").getImmediate(),r=e.getProvider("heartbeat");return Oe(t,r)},"PUBLIC").setInstantiationMode("EXPLICIT").setInstanceCreatedCallback((e,t,r)=>{e.getProvider(L).initialize()})),H(new O(L,e=>{const t=e.getProvider("app-check").getImmediate();return Be(t)},"PUBLIC").setInstantiationMode("EXPLICIT")),de(Ke,Le)}Ye();export{te as CustomProvider,ee as ReCaptchaEnterpriseProvider,Q as ReCaptchaV3Provider,tt as getLimitedUseToken,et as getToken,Ze as initializeAppCheck,rt as onTokenChanged,Qe as setTokenAutoRefreshEnabled};
