import{F as om,L as am,a as ie,g as It,i as Zo,p as Ml,u as um,d as cs,c as cm,b as lm,_ as Ol,e as hm,f as dm,h as fm,j as mm,k as si,l as Ll,m as ql,n as gm,o as pm,C as _m,r as cc,S as ym}from"./index-C-zKinvL.js";var lc=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{};/** @license
Copyright The Closure Library Authors.
SPDX-License-Identifier: Apache-2.0
*/var Ve,Bl;(function(){var r;/** @license

 Copyright The Closure Library Authors.
 SPDX-License-Identifier: Apache-2.0
*/function t(T,_){function I(){}I.prototype=_.prototype,T.F=_.prototype,T.prototype=new I,T.prototype.constructor=T,T.D=function(w,E,S){for(var y=Array(arguments.length-2),Ft=2;Ft<arguments.length;Ft++)y[Ft-2]=arguments[Ft];return _.prototype[E].apply(w,y)}}function e(){this.blockSize=-1}function n(){this.blockSize=-1,this.blockSize=64,this.g=Array(4),this.C=Array(this.blockSize),this.o=this.h=0,this.u()}t(n,e),n.prototype.u=function(){this.g[0]=1732584193,this.g[1]=4023233417,this.g[2]=2562383102,this.g[3]=271733878,this.o=this.h=0};function s(T,_,I){I||(I=0);const w=Array(16);if(typeof _=="string")for(var E=0;E<16;++E)w[E]=_.charCodeAt(I++)|_.charCodeAt(I++)<<8|_.charCodeAt(I++)<<16|_.charCodeAt(I++)<<24;else for(E=0;E<16;++E)w[E]=_[I++]|_[I++]<<8|_[I++]<<16|_[I++]<<24;_=T.g[0],I=T.g[1],E=T.g[2];let S=T.g[3],y;y=_+(S^I&(E^S))+w[0]+3614090360&4294967295,_=I+(y<<7&4294967295|y>>>25),y=S+(E^_&(I^E))+w[1]+3905402710&4294967295,S=_+(y<<12&4294967295|y>>>20),y=E+(I^S&(_^I))+w[2]+606105819&4294967295,E=S+(y<<17&4294967295|y>>>15),y=I+(_^E&(S^_))+w[3]+3250441966&4294967295,I=E+(y<<22&4294967295|y>>>10),y=_+(S^I&(E^S))+w[4]+4118548399&4294967295,_=I+(y<<7&4294967295|y>>>25),y=S+(E^_&(I^E))+w[5]+1200080426&4294967295,S=_+(y<<12&4294967295|y>>>20),y=E+(I^S&(_^I))+w[6]+2821735955&4294967295,E=S+(y<<17&4294967295|y>>>15),y=I+(_^E&(S^_))+w[7]+4249261313&4294967295,I=E+(y<<22&4294967295|y>>>10),y=_+(S^I&(E^S))+w[8]+1770035416&4294967295,_=I+(y<<7&4294967295|y>>>25),y=S+(E^_&(I^E))+w[9]+2336552879&4294967295,S=_+(y<<12&4294967295|y>>>20),y=E+(I^S&(_^I))+w[10]+4294925233&4294967295,E=S+(y<<17&4294967295|y>>>15),y=I+(_^E&(S^_))+w[11]+2304563134&4294967295,I=E+(y<<22&4294967295|y>>>10),y=_+(S^I&(E^S))+w[12]+1804603682&4294967295,_=I+(y<<7&4294967295|y>>>25),y=S+(E^_&(I^E))+w[13]+4254626195&4294967295,S=_+(y<<12&4294967295|y>>>20),y=E+(I^S&(_^I))+w[14]+2792965006&4294967295,E=S+(y<<17&4294967295|y>>>15),y=I+(_^E&(S^_))+w[15]+1236535329&4294967295,I=E+(y<<22&4294967295|y>>>10),y=_+(E^S&(I^E))+w[1]+4129170786&4294967295,_=I+(y<<5&4294967295|y>>>27),y=S+(I^E&(_^I))+w[6]+3225465664&4294967295,S=_+(y<<9&4294967295|y>>>23),y=E+(_^I&(S^_))+w[11]+643717713&4294967295,E=S+(y<<14&4294967295|y>>>18),y=I+(S^_&(E^S))+w[0]+3921069994&4294967295,I=E+(y<<20&4294967295|y>>>12),y=_+(E^S&(I^E))+w[5]+3593408605&4294967295,_=I+(y<<5&4294967295|y>>>27),y=S+(I^E&(_^I))+w[10]+38016083&4294967295,S=_+(y<<9&4294967295|y>>>23),y=E+(_^I&(S^_))+w[15]+3634488961&4294967295,E=S+(y<<14&4294967295|y>>>18),y=I+(S^_&(E^S))+w[4]+3889429448&4294967295,I=E+(y<<20&4294967295|y>>>12),y=_+(E^S&(I^E))+w[9]+568446438&4294967295,_=I+(y<<5&4294967295|y>>>27),y=S+(I^E&(_^I))+w[14]+3275163606&4294967295,S=_+(y<<9&4294967295|y>>>23),y=E+(_^I&(S^_))+w[3]+4107603335&4294967295,E=S+(y<<14&4294967295|y>>>18),y=I+(S^_&(E^S))+w[8]+1163531501&4294967295,I=E+(y<<20&4294967295|y>>>12),y=_+(E^S&(I^E))+w[13]+2850285829&4294967295,_=I+(y<<5&4294967295|y>>>27),y=S+(I^E&(_^I))+w[2]+4243563512&4294967295,S=_+(y<<9&4294967295|y>>>23),y=E+(_^I&(S^_))+w[7]+1735328473&4294967295,E=S+(y<<14&4294967295|y>>>18),y=I+(S^_&(E^S))+w[12]+2368359562&4294967295,I=E+(y<<20&4294967295|y>>>12),y=_+(I^E^S)+w[5]+4294588738&4294967295,_=I+(y<<4&4294967295|y>>>28),y=S+(_^I^E)+w[8]+2272392833&4294967295,S=_+(y<<11&4294967295|y>>>21),y=E+(S^_^I)+w[11]+1839030562&4294967295,E=S+(y<<16&4294967295|y>>>16),y=I+(E^S^_)+w[14]+4259657740&4294967295,I=E+(y<<23&4294967295|y>>>9),y=_+(I^E^S)+w[1]+2763975236&4294967295,_=I+(y<<4&4294967295|y>>>28),y=S+(_^I^E)+w[4]+1272893353&4294967295,S=_+(y<<11&4294967295|y>>>21),y=E+(S^_^I)+w[7]+4139469664&4294967295,E=S+(y<<16&4294967295|y>>>16),y=I+(E^S^_)+w[10]+3200236656&4294967295,I=E+(y<<23&4294967295|y>>>9),y=_+(I^E^S)+w[13]+681279174&4294967295,_=I+(y<<4&4294967295|y>>>28),y=S+(_^I^E)+w[0]+3936430074&4294967295,S=_+(y<<11&4294967295|y>>>21),y=E+(S^_^I)+w[3]+3572445317&4294967295,E=S+(y<<16&4294967295|y>>>16),y=I+(E^S^_)+w[6]+76029189&4294967295,I=E+(y<<23&4294967295|y>>>9),y=_+(I^E^S)+w[9]+3654602809&4294967295,_=I+(y<<4&4294967295|y>>>28),y=S+(_^I^E)+w[12]+3873151461&4294967295,S=_+(y<<11&4294967295|y>>>21),y=E+(S^_^I)+w[15]+530742520&4294967295,E=S+(y<<16&4294967295|y>>>16),y=I+(E^S^_)+w[2]+3299628645&4294967295,I=E+(y<<23&4294967295|y>>>9),y=_+(E^(I|~S))+w[0]+4096336452&4294967295,_=I+(y<<6&4294967295|y>>>26),y=S+(I^(_|~E))+w[7]+1126891415&4294967295,S=_+(y<<10&4294967295|y>>>22),y=E+(_^(S|~I))+w[14]+2878612391&4294967295,E=S+(y<<15&4294967295|y>>>17),y=I+(S^(E|~_))+w[5]+4237533241&4294967295,I=E+(y<<21&4294967295|y>>>11),y=_+(E^(I|~S))+w[12]+1700485571&4294967295,_=I+(y<<6&4294967295|y>>>26),y=S+(I^(_|~E))+w[3]+2399980690&4294967295,S=_+(y<<10&4294967295|y>>>22),y=E+(_^(S|~I))+w[10]+4293915773&4294967295,E=S+(y<<15&4294967295|y>>>17),y=I+(S^(E|~_))+w[1]+2240044497&4294967295,I=E+(y<<21&4294967295|y>>>11),y=_+(E^(I|~S))+w[8]+1873313359&4294967295,_=I+(y<<6&4294967295|y>>>26),y=S+(I^(_|~E))+w[15]+4264355552&4294967295,S=_+(y<<10&4294967295|y>>>22),y=E+(_^(S|~I))+w[6]+2734768916&4294967295,E=S+(y<<15&4294967295|y>>>17),y=I+(S^(E|~_))+w[13]+1309151649&4294967295,I=E+(y<<21&4294967295|y>>>11),y=_+(E^(I|~S))+w[4]+4149444226&4294967295,_=I+(y<<6&4294967295|y>>>26),y=S+(I^(_|~E))+w[11]+3174756917&4294967295,S=_+(y<<10&4294967295|y>>>22),y=E+(_^(S|~I))+w[2]+718787259&4294967295,E=S+(y<<15&4294967295|y>>>17),y=I+(S^(E|~_))+w[9]+3951481745&4294967295,T.g[0]=T.g[0]+_&4294967295,T.g[1]=T.g[1]+(E+(y<<21&4294967295|y>>>11))&4294967295,T.g[2]=T.g[2]+E&4294967295,T.g[3]=T.g[3]+S&4294967295}n.prototype.v=function(T,_){_===void 0&&(_=T.length);const I=_-this.blockSize,w=this.C;let E=this.h,S=0;for(;S<_;){if(E==0)for(;S<=I;)s(this,T,S),S+=this.blockSize;if(typeof T=="string"){for(;S<_;)if(w[E++]=T.charCodeAt(S++),E==this.blockSize){s(this,w),E=0;break}}else for(;S<_;)if(w[E++]=T[S++],E==this.blockSize){s(this,w),E=0;break}}this.h=E,this.o+=_},n.prototype.A=function(){var T=Array((this.h<56?this.blockSize:this.blockSize*2)-this.h);T[0]=128;for(var _=1;_<T.length-8;++_)T[_]=0;_=this.o*8;for(var I=T.length-8;I<T.length;++I)T[I]=_&255,_/=256;for(this.v(T),T=Array(16),_=0,I=0;I<4;++I)for(let w=0;w<32;w+=8)T[_++]=this.g[I]>>>w&255;return T};function i(T,_){var I=u;return Object.prototype.hasOwnProperty.call(I,T)?I[T]:I[T]=_(T)}function a(T,_){this.h=_;const I=[];let w=!0;for(let E=T.length-1;E>=0;E--){const S=T[E]|0;w&&S==_||(I[E]=S,w=!1)}this.g=I}var u={};function c(T){return-128<=T&&T<128?i(T,function(_){return new a([_|0],_<0?-1:0)}):new a([T|0],T<0?-1:0)}function h(T){if(isNaN(T)||!isFinite(T))return m;if(T<0)return D(h(-T));const _=[];let I=1;for(let w=0;T>=I;w++)_[w]=T/I|0,I*=4294967296;return new a(_,0)}function f(T,_){if(T.length==0)throw Error("number format error: empty string");if(_=_||10,_<2||36<_)throw Error("radix out of range: "+_);if(T.charAt(0)=="-")return D(f(T.substring(1),_));if(T.indexOf("-")>=0)throw Error('number format error: interior "-" character');const I=h(Math.pow(_,8));let w=m;for(let S=0;S<T.length;S+=8){var E=Math.min(8,T.length-S);const y=parseInt(T.substring(S,S+E),_);E<8?(E=h(Math.pow(_,E)),w=w.j(E).add(h(y))):(w=w.j(I),w=w.add(h(y)))}return w}var m=c(0),p=c(1),v=c(16777216);r=a.prototype,r.m=function(){if(N(this))return-D(this).m();let T=0,_=1;for(let I=0;I<this.g.length;I++){const w=this.i(I);T+=(w>=0?w:4294967296+w)*_,_*=4294967296}return T},r.toString=function(T){if(T=T||10,T<2||36<T)throw Error("radix out of range: "+T);if(C(this))return"0";if(N(this))return"-"+D(this).toString(T);const _=h(Math.pow(T,6));var I=this;let w="";for(;;){const E=X(I,_).g;I=q(I,E.j(_));let S=((I.g.length>0?I.g[0]:I.h)>>>0).toString(T);if(I=E,C(I))return S+w;for(;S.length<6;)S="0"+S;w=S+w}},r.i=function(T){return T<0?0:T<this.g.length?this.g[T]:this.h};function C(T){if(T.h!=0)return!1;for(let _=0;_<T.g.length;_++)if(T.g[_]!=0)return!1;return!0}function N(T){return T.h==-1}r.l=function(T){return T=q(this,T),N(T)?-1:C(T)?0:1};function D(T){const _=T.g.length,I=[];for(let w=0;w<_;w++)I[w]=~T.g[w];return new a(I,~T.h).add(p)}r.abs=function(){return N(this)?D(this):this},r.add=function(T){const _=Math.max(this.g.length,T.g.length),I=[];let w=0;for(let E=0;E<=_;E++){let S=w+(this.i(E)&65535)+(T.i(E)&65535),y=(S>>>16)+(this.i(E)>>>16)+(T.i(E)>>>16);w=y>>>16,S&=65535,y&=65535,I[E]=y<<16|S}return new a(I,I[I.length-1]&-2147483648?-1:0)};function q(T,_){return T.add(D(_))}r.j=function(T){if(C(this)||C(T))return m;if(N(this))return N(T)?D(this).j(D(T)):D(D(this).j(T));if(N(T))return D(this.j(D(T)));if(this.l(v)<0&&T.l(v)<0)return h(this.m()*T.m());const _=this.g.length+T.g.length,I=[];for(var w=0;w<2*_;w++)I[w]=0;for(w=0;w<this.g.length;w++)for(let E=0;E<T.g.length;E++){const S=this.i(w)>>>16,y=this.i(w)&65535,Ft=T.i(E)>>>16,ze=T.i(E)&65535;I[2*w+2*E]+=y*ze,j(I,2*w+2*E),I[2*w+2*E+1]+=S*ze,j(I,2*w+2*E+1),I[2*w+2*E+1]+=y*Ft,j(I,2*w+2*E+1),I[2*w+2*E+2]+=S*Ft,j(I,2*w+2*E+2)}for(T=0;T<_;T++)I[T]=I[2*T+1]<<16|I[2*T];for(T=_;T<2*_;T++)I[T]=0;return new a(I,0)};function j(T,_){for(;(T[_]&65535)!=T[_];)T[_+1]+=T[_]>>>16,T[_]&=65535,_++}function U(T,_){this.g=T,this.h=_}function X(T,_){if(C(_))throw Error("division by zero");if(C(T))return new U(m,m);if(N(T))return _=X(D(T),_),new U(D(_.g),D(_.h));if(N(_))return _=X(T,D(_)),new U(D(_.g),_.h);if(T.g.length>30){if(N(T)||N(_))throw Error("slowDivide_ only works with positive integers.");for(var I=p,w=_;w.l(T)<=0;)I=J(I),w=J(w);var E=Y(I,1),S=Y(w,1);for(w=Y(w,2),I=Y(I,2);!C(w);){var y=S.add(w);y.l(T)<=0&&(E=E.add(I),S=y),w=Y(w,1),I=Y(I,1)}return _=q(T,E.j(_)),new U(E,_)}for(E=m;T.l(_)>=0;){for(I=Math.max(1,Math.floor(T.m()/_.m())),w=Math.ceil(Math.log(I)/Math.LN2),w=w<=48?1:Math.pow(2,w-48),S=h(I),y=S.j(_);N(y)||y.l(T)>0;)I-=w,S=h(I),y=S.j(_);C(S)&&(S=p),E=E.add(S),T=q(T,y)}return new U(E,T)}r.B=function(T){return X(this,T).h},r.and=function(T){const _=Math.max(this.g.length,T.g.length),I=[];for(let w=0;w<_;w++)I[w]=this.i(w)&T.i(w);return new a(I,this.h&T.h)},r.or=function(T){const _=Math.max(this.g.length,T.g.length),I=[];for(let w=0;w<_;w++)I[w]=this.i(w)|T.i(w);return new a(I,this.h|T.h)},r.xor=function(T){const _=Math.max(this.g.length,T.g.length),I=[];for(let w=0;w<_;w++)I[w]=this.i(w)^T.i(w);return new a(I,this.h^T.h)};function J(T){const _=T.g.length+1,I=[];for(let w=0;w<_;w++)I[w]=T.i(w)<<1|T.i(w-1)>>>31;return new a(I,T.h)}function Y(T,_){const I=_>>5;_%=32;const w=T.g.length-I,E=[];for(let S=0;S<w;S++)E[S]=_>0?T.i(S+I)>>>_|T.i(S+I+1)<<32-_:T.i(S+I);return new a(E,T.h)}n.prototype.digest=n.prototype.A,n.prototype.reset=n.prototype.u,n.prototype.update=n.prototype.v,Bl=n,a.prototype.add=a.prototype.add,a.prototype.multiply=a.prototype.j,a.prototype.modulo=a.prototype.B,a.prototype.compare=a.prototype.l,a.prototype.toNumber=a.prototype.m,a.prototype.toString=a.prototype.toString,a.prototype.getBits=a.prototype.i,a.fromNumber=h,a.fromString=f,Ve=a}).apply(typeof lc<"u"?lc:typeof self<"u"?self:typeof window<"u"?window:{});var qs=typeof globalThis<"u"?globalThis:typeof window<"u"?window:typeof global<"u"?global:typeof self<"u"?self:{};/** @license
Copyright The Closure Library Authors.
SPDX-License-Identifier: Apache-2.0
*/var Ul,Or,jl,Qs,Po,zl,Gl,Kl;(function(){var r,t=Object.defineProperty;function e(o){o=[typeof globalThis=="object"&&globalThis,o,typeof window=="object"&&window,typeof self=="object"&&self,typeof qs=="object"&&qs];for(var l=0;l<o.length;++l){var d=o[l];if(d&&d.Math==Math)return d}throw Error("Cannot find global object")}var n=e(this);function s(o,l){if(l)t:{var d=n;o=o.split(".");for(var g=0;g<o.length-1;g++){var R=o[g];if(!(R in d))break t;d=d[R]}o=o[o.length-1],g=d[o],l=l(g),l!=g&&l!=null&&t(d,o,{configurable:!0,writable:!0,value:l})}}s("Symbol.dispose",function(o){return o||Symbol("Symbol.dispose")}),s("Array.prototype.values",function(o){return o||function(){return this[Symbol.iterator]()}}),s("Object.entries",function(o){return o||function(l){var d=[],g;for(g in l)Object.prototype.hasOwnProperty.call(l,g)&&d.push([g,l[g]]);return d}});/** @license

 Copyright The Closure Library Authors.
 SPDX-License-Identifier: Apache-2.0
*/var i=i||{},a=this||self;function u(o){var l=typeof o;return l=="object"&&o!=null||l=="function"}function c(o,l,d){return o.call.apply(o.bind,arguments)}function h(o,l,d){return h=c,h.apply(null,arguments)}function f(o,l){var d=Array.prototype.slice.call(arguments,1);return function(){var g=d.slice();return g.push.apply(g,arguments),o.apply(this,g)}}function m(o,l){function d(){}d.prototype=l.prototype,o.Z=l.prototype,o.prototype=new d,o.prototype.constructor=o,o.Ob=function(g,R,V){for(var M=Array(arguments.length-2),K=2;K<arguments.length;K++)M[K-2]=arguments[K];return l.prototype[R].apply(g,M)}}var p=typeof AsyncContext<"u"&&typeof AsyncContext.Snapshot=="function"?o=>o&&AsyncContext.Snapshot.wrap(o):o=>o;function v(o){const l=o.length;if(l>0){const d=Array(l);for(let g=0;g<l;g++)d[g]=o[g];return d}return[]}function C(o,l){for(let g=1;g<arguments.length;g++){const R=arguments[g];var d=typeof R;if(d=d!="object"?d:R?Array.isArray(R)?"array":d:"null",d=="array"||d=="object"&&typeof R.length=="number"){d=o.length||0;const V=R.length||0;o.length=d+V;for(let M=0;M<V;M++)o[d+M]=R[M]}else o.push(R)}}class N{constructor(l,d){this.i=l,this.j=d,this.h=0,this.g=null}get(){let l;return this.h>0?(this.h--,l=this.g,this.g=l.next,l.next=null):l=this.i(),l}}function D(o){a.setTimeout(()=>{throw o},0)}function q(){var o=T;let l=null;return o.g&&(l=o.g,o.g=o.g.next,o.g||(o.h=null),l.next=null),l}class j{constructor(){this.h=this.g=null}add(l,d){const g=U.get();g.set(l,d),this.h?this.h.next=g:this.g=g,this.h=g}}var U=new N(()=>new X,o=>o.reset());class X{constructor(){this.next=this.g=this.h=null}set(l,d){this.h=l,this.g=d,this.next=null}reset(){this.next=this.g=this.h=null}}let J,Y=!1,T=new j,_=()=>{const o=Promise.resolve(void 0);J=()=>{o.then(I)}};function I(){for(var o;o=q();){try{o.h.call(o.g)}catch(d){D(d)}var l=U;l.j(o),l.h<100&&(l.h++,o.next=l.g,l.g=o)}Y=!1}function w(){this.u=this.u,this.C=this.C}w.prototype.u=!1,w.prototype.dispose=function(){this.u||(this.u=!0,this.N())},w.prototype[Symbol.dispose]=function(){this.dispose()},w.prototype.N=function(){if(this.C)for(;this.C.length;)this.C.shift()()};function E(o,l){this.type=o,this.g=this.target=l,this.defaultPrevented=!1}E.prototype.h=function(){this.defaultPrevented=!0};var S=(function(){if(!a.addEventListener||!Object.defineProperty)return!1;var o=!1,l=Object.defineProperty({},"passive",{get:function(){o=!0}});try{const d=()=>{};a.addEventListener("test",d,l),a.removeEventListener("test",d,l)}catch{}return o})();function y(o){return/^[\s\xa0]*$/.test(o)}function Ft(o,l){E.call(this,o?o.type:""),this.relatedTarget=this.g=this.target=null,this.button=this.screenY=this.screenX=this.clientY=this.clientX=0,this.key="",this.metaKey=this.shiftKey=this.altKey=this.ctrlKey=!1,this.state=null,this.pointerId=0,this.pointerType="",this.i=null,o&&this.init(o,l)}m(Ft,E),Ft.prototype.init=function(o,l){const d=this.type=o.type,g=o.changedTouches&&o.changedTouches.length?o.changedTouches[0]:null;this.target=o.target||o.srcElement,this.g=l,l=o.relatedTarget,l||(d=="mouseover"?l=o.fromElement:d=="mouseout"&&(l=o.toElement)),this.relatedTarget=l,g?(this.clientX=g.clientX!==void 0?g.clientX:g.pageX,this.clientY=g.clientY!==void 0?g.clientY:g.pageY,this.screenX=g.screenX||0,this.screenY=g.screenY||0):(this.clientX=o.clientX!==void 0?o.clientX:o.pageX,this.clientY=o.clientY!==void 0?o.clientY:o.pageY,this.screenX=o.screenX||0,this.screenY=o.screenY||0),this.button=o.button,this.key=o.key||"",this.ctrlKey=o.ctrlKey,this.altKey=o.altKey,this.shiftKey=o.shiftKey,this.metaKey=o.metaKey,this.pointerId=o.pointerId||0,this.pointerType=o.pointerType,this.state=o.state,this.i=o,o.defaultPrevented&&Ft.Z.h.call(this)},Ft.prototype.h=function(){Ft.Z.h.call(this);const o=this.i;o.preventDefault?o.preventDefault():o.returnValue=!1};var ze="closure_listenable_"+(Math.random()*1e6|0),Vf=0;function bf(o,l,d,g,R){this.listener=o,this.proxy=null,this.src=l,this.type=d,this.capture=!!g,this.ha=R,this.key=++Vf,this.da=this.fa=!1}function vs(o){o.da=!0,o.listener=null,o.proxy=null,o.src=null,o.ha=null}function Rs(o,l,d){for(const g in o)l.call(d,o[g],g,o)}function Cf(o,l){for(const d in o)l.call(void 0,o[d],d,o)}function uu(o){const l={};for(const d in o)l[d]=o[d];return l}const cu="constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf".split(" ");function lu(o,l){let d,g;for(let R=1;R<arguments.length;R++){g=arguments[R];for(d in g)o[d]=g[d];for(let V=0;V<cu.length;V++)d=cu[V],Object.prototype.hasOwnProperty.call(g,d)&&(o[d]=g[d])}}function Ps(o){this.src=o,this.g={},this.h=0}Ps.prototype.add=function(o,l,d,g,R){const V=o.toString();o=this.g[V],o||(o=this.g[V]=[],this.h++);const M=Qi(o,l,g,R);return M>-1?(l=o[M],d||(l.fa=!1)):(l=new bf(l,this.src,V,!!g,R),l.fa=d,o.push(l)),l};function $i(o,l){const d=l.type;if(d in o.g){var g=o.g[d],R=Array.prototype.indexOf.call(g,l,void 0),V;(V=R>=0)&&Array.prototype.splice.call(g,R,1),V&&(vs(l),o.g[d].length==0&&(delete o.g[d],o.h--))}}function Qi(o,l,d,g){for(let R=0;R<o.length;++R){const V=o[R];if(!V.da&&V.listener==l&&V.capture==!!d&&V.ha==g)return R}return-1}var Wi="closure_lm_"+(Math.random()*1e6|0),Hi={};function hu(o,l,d,g,R){if(Array.isArray(l)){for(let V=0;V<l.length;V++)hu(o,l[V],d,g,R);return null}return d=mu(d),o&&o[ze]?o.J(l,d,u(g)?!!g.capture:!1,R):xf(o,l,d,!1,g,R)}function xf(o,l,d,g,R,V){if(!l)throw Error("Invalid event type");const M=u(R)?!!R.capture:!!R;let K=Yi(o);if(K||(o[Wi]=K=new Ps(o)),d=K.add(l,d,g,M,V),d.proxy)return d;if(g=Df(),d.proxy=g,g.src=o,g.listener=d,o.addEventListener)S||(R=M),R===void 0&&(R=!1),o.addEventListener(l.toString(),g,R);else if(o.attachEvent)o.attachEvent(fu(l.toString()),g);else if(o.addListener&&o.removeListener)o.addListener(g);else throw Error("addEventListener and attachEvent are unavailable.");return d}function Df(){function o(d){return l.call(o.src,o.listener,d)}const l=Nf;return o}function du(o,l,d,g,R){if(Array.isArray(l))for(var V=0;V<l.length;V++)du(o,l[V],d,g,R);else g=u(g)?!!g.capture:!!g,d=mu(d),o&&o[ze]?(o=o.i,V=String(l).toString(),V in o.g&&(l=o.g[V],d=Qi(l,d,g,R),d>-1&&(vs(l[d]),Array.prototype.splice.call(l,d,1),l.length==0&&(delete o.g[V],o.h--)))):o&&(o=Yi(o))&&(l=o.g[l.toString()],o=-1,l&&(o=Qi(l,d,g,R)),(d=o>-1?l[o]:null)&&Ji(d))}function Ji(o){if(typeof o!="number"&&o&&!o.da){var l=o.src;if(l&&l[ze])$i(l.i,o);else{var d=o.type,g=o.proxy;l.removeEventListener?l.removeEventListener(d,g,o.capture):l.detachEvent?l.detachEvent(fu(d),g):l.addListener&&l.removeListener&&l.removeListener(g),(d=Yi(l))?($i(d,o),d.h==0&&(d.src=null,l[Wi]=null)):vs(o)}}}function fu(o){return o in Hi?Hi[o]:Hi[o]="on"+o}function Nf(o,l){if(o.da)o=!0;else{l=new Ft(l,this);const d=o.listener,g=o.ha||o.src;o.fa&&Ji(o),o=d.call(g,l)}return o}function Yi(o){return o=o[Wi],o instanceof Ps?o:null}var Xi="__closure_events_fn_"+(Math.random()*1e9>>>0);function mu(o){return typeof o=="function"?o:(o[Xi]||(o[Xi]=function(l){return o.handleEvent(l)}),o[Xi])}function Vt(){w.call(this),this.i=new Ps(this),this.M=this,this.G=null}m(Vt,w),Vt.prototype[ze]=!0,Vt.prototype.removeEventListener=function(o,l,d,g){du(this,o,l,d,g)};function Nt(o,l){var d,g=o.G;if(g)for(d=[];g;g=g.G)d.push(g);if(o=o.M,g=l.type||l,typeof l=="string")l=new E(l,o);else if(l instanceof E)l.target=l.target||o;else{var R=l;l=new E(g,o),lu(l,R)}R=!0;let V,M;if(d)for(M=d.length-1;M>=0;M--)V=l.g=d[M],R=Ss(V,g,!0,l)&&R;if(V=l.g=o,R=Ss(V,g,!0,l)&&R,R=Ss(V,g,!1,l)&&R,d)for(M=0;M<d.length;M++)V=l.g=d[M],R=Ss(V,g,!1,l)&&R}Vt.prototype.N=function(){if(Vt.Z.N.call(this),this.i){var o=this.i;for(const l in o.g){const d=o.g[l];for(let g=0;g<d.length;g++)vs(d[g]);delete o.g[l],o.h--}}this.G=null},Vt.prototype.J=function(o,l,d,g){return this.i.add(String(o),l,!1,d,g)},Vt.prototype.K=function(o,l,d,g){return this.i.add(String(o),l,!0,d,g)};function Ss(o,l,d,g){if(l=o.i.g[String(l)],!l)return!0;l=l.concat();let R=!0;for(let V=0;V<l.length;++V){const M=l[V];if(M&&!M.da&&M.capture==d){const K=M.listener,yt=M.ha||M.src;M.fa&&$i(o.i,M),R=K.call(yt,g)!==!1&&R}}return R&&!g.defaultPrevented}function kf(o,l){if(typeof o!="function")if(o&&typeof o.handleEvent=="function")o=h(o.handleEvent,o);else throw Error("Invalid listener argument");return Number(l)>2147483647?-1:a.setTimeout(o,l||0)}function gu(o){o.g=kf(()=>{o.g=null,o.i&&(o.i=!1,gu(o))},o.l);const l=o.h;o.h=null,o.m.apply(null,l)}class Ff extends w{constructor(l,d){super(),this.m=l,this.l=d,this.h=null,this.i=!1,this.g=null}j(l){this.h=arguments,this.g?this.i=!0:gu(this)}N(){super.N(),this.g&&(a.clearTimeout(this.g),this.g=null,this.i=!1,this.h=null)}}function gr(o){w.call(this),this.h=o,this.g={}}m(gr,w);var pu=[];function _u(o){Rs(o.g,function(l,d){this.g.hasOwnProperty(d)&&Ji(l)},o),o.g={}}gr.prototype.N=function(){gr.Z.N.call(this),_u(this)},gr.prototype.handleEvent=function(){throw Error("EventHandler.handleEvent not implemented")};var Zi=a.JSON.stringify,Mf=a.JSON.parse,Of=class{stringify(o){return a.JSON.stringify(o,void 0)}parse(o){return a.JSON.parse(o,void 0)}};function yu(){}function Iu(){}var pr={OPEN:"a",hb:"b",ERROR:"c",tb:"d"};function to(){E.call(this,"d")}m(to,E);function eo(){E.call(this,"c")}m(eo,E);var Ge={},Tu=null;function Vs(){return Tu=Tu||new Vt}Ge.Ia="serverreachability";function Eu(o){E.call(this,Ge.Ia,o)}m(Eu,E);function _r(o){const l=Vs();Nt(l,new Eu(l))}Ge.STAT_EVENT="statevent";function wu(o,l){E.call(this,Ge.STAT_EVENT,o),this.stat=l}m(wu,E);function kt(o){const l=Vs();Nt(l,new wu(l,o))}Ge.Ja="timingevent";function Au(o,l){E.call(this,Ge.Ja,o),this.size=l}m(Au,E);function yr(o,l){if(typeof o!="function")throw Error("Fn must not be null and must be a function");return a.setTimeout(function(){o()},l)}function Ir(){this.g=!0}Ir.prototype.ua=function(){this.g=!1};function Lf(o,l,d,g,R,V){o.info(function(){if(o.g)if(V){var M="",K=V.split("&");for(let rt=0;rt<K.length;rt++){var yt=K[rt].split("=");if(yt.length>1){const Et=yt[0];yt=yt[1];const Ht=Et.split("_");M=Ht.length>=2&&Ht[1]=="type"?M+(Et+"="+yt+"&"):M+(Et+"=redacted&")}}}else M=null;else M=V;return"XMLHTTP REQ ("+g+") [attempt "+R+"]: "+l+`
`+d+`
`+M})}function qf(o,l,d,g,R,V,M){o.info(function(){return"XMLHTTP RESP ("+g+") [ attempt "+R+"]: "+l+`
`+d+`
`+V+" "+M})}function wn(o,l,d,g){o.info(function(){return"XMLHTTP TEXT ("+l+"): "+Uf(o,d)+(g?" "+g:"")})}function Bf(o,l){o.info(function(){return"TIMEOUT: "+l})}Ir.prototype.info=function(){};function Uf(o,l){if(!o.g)return l;if(!l)return null;try{const V=JSON.parse(l);if(V){for(o=0;o<V.length;o++)if(Array.isArray(V[o])){var d=V[o];if(!(d.length<2)){var g=d[1];if(Array.isArray(g)&&!(g.length<1)){var R=g[0];if(R!="noop"&&R!="stop"&&R!="close")for(let M=1;M<g.length;M++)g[M]=""}}}}return Zi(V)}catch{return l}}var bs={NO_ERROR:0,cb:1,qb:2,pb:3,kb:4,ob:5,rb:6,Ga:7,TIMEOUT:8,ub:9},vu={ib:"complete",Fb:"success",ERROR:"error",Ga:"abort",xb:"ready",yb:"readystatechange",TIMEOUT:"timeout",sb:"incrementaldata",wb:"progress",lb:"downloadprogress",Nb:"uploadprogress"},Ru;function no(){}m(no,yu),no.prototype.g=function(){return new XMLHttpRequest},Ru=new no;function Tr(o){return encodeURIComponent(String(o))}function jf(o){var l=1;o=o.split(":");const d=[];for(;l>0&&o.length;)d.push(o.shift()),l--;return o.length&&d.push(o.join(":")),d}function me(o,l,d,g){this.j=o,this.i=l,this.l=d,this.S=g||1,this.V=new gr(this),this.H=45e3,this.J=null,this.o=!1,this.u=this.B=this.A=this.M=this.F=this.T=this.D=null,this.G=[],this.g=null,this.C=0,this.m=this.v=null,this.X=-1,this.K=!1,this.P=0,this.O=null,this.W=this.L=this.U=this.R=!1,this.h=new Pu}function Pu(){this.i=null,this.g="",this.h=!1}var Su={},ro={};function so(o,l,d){o.M=1,o.A=xs(Wt(l)),o.u=d,o.R=!0,Vu(o,null)}function Vu(o,l){o.F=Date.now(),Cs(o),o.B=Wt(o.A);var d=o.B,g=o.S;Array.isArray(g)||(g=[String(g)]),Uu(d.i,"t",g),o.C=0,d=o.j.L,o.h=new Pu,o.g=ic(o.j,d?l:null,!o.u),o.P>0&&(o.O=new Ff(h(o.Y,o,o.g),o.P)),l=o.V,d=o.g,g=o.ba;var R="readystatechange";Array.isArray(R)||(R&&(pu[0]=R.toString()),R=pu);for(let V=0;V<R.length;V++){const M=hu(d,R[V],g||l.handleEvent,!1,l.h||l);if(!M)break;l.g[M.key]=M}l=o.J?uu(o.J):{},o.u?(o.v||(o.v="POST"),l["Content-Type"]="application/x-www-form-urlencoded",o.g.ea(o.B,o.v,o.u,l)):(o.v="GET",o.g.ea(o.B,o.v,null,l)),_r(),Lf(o.i,o.v,o.B,o.l,o.S,o.u)}me.prototype.ba=function(o){o=o.target;const l=this.O;l&&_e(o)==3?l.j():this.Y(o)},me.prototype.Y=function(o){try{if(o==this.g)t:{const K=_e(this.g),yt=this.g.ya(),rt=this.g.ca();if(!(K<3)&&(K!=3||this.g&&(this.h.h||this.g.la()||Wu(this.g)))){this.K||K!=4||yt==7||(yt==8||rt<=0?_r(3):_r(2)),io(this);var l=this.g.ca();this.X=l;var d=zf(this);if(this.o=l==200,qf(this.i,this.v,this.B,this.l,this.S,K,l),this.o){if(this.U&&!this.L){e:{if(this.g){var g,R=this.g;if((g=R.g?R.g.getResponseHeader("X-HTTP-Initial-Response"):null)&&!y(g)){var V=g;break e}}V=null}if(o=V)wn(this.i,this.l,o,"Initial handshake response via X-HTTP-Initial-Response"),this.L=!0,oo(this,o);else{this.o=!1,this.m=3,kt(12),Ke(this),Er(this);break t}}if(this.R){o=!0;let Et;for(;!this.K&&this.C<d.length;)if(Et=Gf(this,d),Et==ro){K==4&&(this.m=4,kt(14),o=!1),wn(this.i,this.l,null,"[Incomplete Response]");break}else if(Et==Su){this.m=4,kt(15),wn(this.i,this.l,d,"[Invalid Chunk]"),o=!1;break}else wn(this.i,this.l,Et,null),oo(this,Et);if(bu(this)&&this.C!=0&&(this.h.g=this.h.g.slice(this.C),this.C=0),K!=4||d.length!=0||this.h.h||(this.m=1,kt(16),o=!1),this.o=this.o&&o,!o)wn(this.i,this.l,d,"[Invalid Chunked Response]"),Ke(this),Er(this);else if(d.length>0&&!this.W){this.W=!0;var M=this.j;M.g==this&&M.aa&&!M.P&&(M.j.info("Great, no buffering proxy detected. Bytes received: "+d.length),go(M),M.P=!0,kt(11))}}else wn(this.i,this.l,d,null),oo(this,d);K==4&&Ke(this),this.o&&!this.K&&(K==4?ec(this.j,this):(this.o=!1,Cs(this)))}else sm(this.g),l==400&&d.indexOf("Unknown SID")>0?(this.m=3,kt(12)):(this.m=0,kt(13)),Ke(this),Er(this)}}}catch{}finally{}};function zf(o){if(!bu(o))return o.g.la();const l=Wu(o.g);if(l==="")return"";let d="";const g=l.length,R=_e(o.g)==4;if(!o.h.i){if(typeof TextDecoder>"u")return Ke(o),Er(o),"";o.h.i=new a.TextDecoder}for(let V=0;V<g;V++)o.h.h=!0,d+=o.h.i.decode(l[V],{stream:!(R&&V==g-1)});return l.length=0,o.h.g+=d,o.C=0,o.h.g}function bu(o){return o.g?o.v=="GET"&&o.M!=2&&o.j.Aa:!1}function Gf(o,l){var d=o.C,g=l.indexOf(`
`,d);return g==-1?ro:(d=Number(l.substring(d,g)),isNaN(d)?Su:(g+=1,g+d>l.length?ro:(l=l.slice(g,g+d),o.C=g+d,l)))}me.prototype.cancel=function(){this.K=!0,Ke(this)};function Cs(o){o.T=Date.now()+o.H,Cu(o,o.H)}function Cu(o,l){if(o.D!=null)throw Error("WatchDog timer not null");o.D=yr(h(o.aa,o),l)}function io(o){o.D&&(a.clearTimeout(o.D),o.D=null)}me.prototype.aa=function(){this.D=null;const o=Date.now();o-this.T>=0?(Bf(this.i,this.B),this.M!=2&&(_r(),kt(17)),Ke(this),this.m=2,Er(this)):Cu(this,this.T-o)};function Er(o){o.j.I==0||o.K||ec(o.j,o)}function Ke(o){io(o);var l=o.O;l&&typeof l.dispose=="function"&&l.dispose(),o.O=null,_u(o.V),o.g&&(l=o.g,o.g=null,l.abort(),l.dispose())}function oo(o,l){try{var d=o.j;if(d.I!=0&&(d.g==o||ao(d.h,o))){if(!o.L&&ao(d.h,o)&&d.I==3){try{var g=d.Ba.g.parse(l)}catch{g=null}if(Array.isArray(g)&&g.length==3){var R=g;if(R[0]==0){t:if(!d.v){if(d.g)if(d.g.F+3e3<o.F)Ms(d),ks(d);else break t;mo(d),kt(18)}}else d.xa=R[1],0<d.xa-d.K&&R[2]<37500&&d.F&&d.A==0&&!d.C&&(d.C=yr(h(d.Va,d),6e3));Nu(d.h)<=1&&d.ta&&(d.ta=void 0)}else Qe(d,11)}else if((o.L||d.g==o)&&Ms(d),!y(l))for(R=d.Ba.g.parse(l),l=0;l<R.length;l++){let rt=R[l];const Et=rt[0];if(!(Et<=d.K))if(d.K=Et,rt=rt[1],d.I==2)if(rt[0]=="c"){d.M=rt[1],d.ba=rt[2];const Ht=rt[3];Ht!=null&&(d.ka=Ht,d.j.info("VER="+d.ka));const We=rt[4];We!=null&&(d.za=We,d.j.info("SVER="+d.za));const ye=rt[5];ye!=null&&typeof ye=="number"&&ye>0&&(g=1.5*ye,d.O=g,d.j.info("backChannelRequestTimeoutMs_="+g)),g=d;const Ie=o.g;if(Ie){const Ls=Ie.g?Ie.g.getResponseHeader("X-Client-Wire-Protocol"):null;if(Ls){var V=g.h;V.g||Ls.indexOf("spdy")==-1&&Ls.indexOf("quic")==-1&&Ls.indexOf("h2")==-1||(V.j=V.l,V.g=new Set,V.h&&(uo(V,V.h),V.h=null))}if(g.G){const po=Ie.g?Ie.g.getResponseHeader("X-HTTP-Session-Id"):null;po&&(g.wa=po,ot(g.J,g.G,po))}}d.I=3,d.l&&d.l.ra(),d.aa&&(d.T=Date.now()-o.F,d.j.info("Handshake RTT: "+d.T+"ms")),g=d;var M=o;if(g.na=sc(g,g.L?g.ba:null,g.W),M.L){ku(g.h,M);var K=M,yt=g.O;yt&&(K.H=yt),K.D&&(io(K),Cs(K)),g.g=M}else Zu(g);d.i.length>0&&Fs(d)}else rt[0]!="stop"&&rt[0]!="close"||Qe(d,7);else d.I==3&&(rt[0]=="stop"||rt[0]=="close"?rt[0]=="stop"?Qe(d,7):fo(d):rt[0]!="noop"&&d.l&&d.l.qa(rt),d.A=0)}}_r(4)}catch{}}var Kf=class{constructor(o,l){this.g=o,this.map=l}};function xu(o){this.l=o||10,a.PerformanceNavigationTiming?(o=a.performance.getEntriesByType("navigation"),o=o.length>0&&(o[0].nextHopProtocol=="hq"||o[0].nextHopProtocol=="h2")):o=!!(a.chrome&&a.chrome.loadTimes&&a.chrome.loadTimes()&&a.chrome.loadTimes().wasFetchedViaSpdy),this.j=o?this.l:1,this.g=null,this.j>1&&(this.g=new Set),this.h=null,this.i=[]}function Du(o){return o.h?!0:o.g?o.g.size>=o.j:!1}function Nu(o){return o.h?1:o.g?o.g.size:0}function ao(o,l){return o.h?o.h==l:o.g?o.g.has(l):!1}function uo(o,l){o.g?o.g.add(l):o.h=l}function ku(o,l){o.h&&o.h==l?o.h=null:o.g&&o.g.has(l)&&o.g.delete(l)}xu.prototype.cancel=function(){if(this.i=Fu(this),this.h)this.h.cancel(),this.h=null;else if(this.g&&this.g.size!==0){for(const o of this.g.values())o.cancel();this.g.clear()}};function Fu(o){if(o.h!=null)return o.i.concat(o.h.G);if(o.g!=null&&o.g.size!==0){let l=o.i;for(const d of o.g.values())l=l.concat(d.G);return l}return v(o.i)}var Mu=RegExp("^(?:([^:/?#.]+):)?(?://(?:([^\\\\/?#]*)@)?([^\\\\/?#]*?)(?::([0-9]+))?(?=[\\\\/?#]|$))?([^?#]+)?(?:\\?([^#]*))?(?:#([\\s\\S]*))?$");function $f(o,l){if(o){o=o.split("&");for(let d=0;d<o.length;d++){const g=o[d].indexOf("=");let R,V=null;g>=0?(R=o[d].substring(0,g),V=o[d].substring(g+1)):R=o[d],l(R,V?decodeURIComponent(V.replace(/\+/g," ")):"")}}}function ge(o){this.g=this.o=this.j="",this.u=null,this.m=this.h="",this.l=!1;let l;o instanceof ge?(this.l=o.l,wr(this,o.j),this.o=o.o,this.g=o.g,Ar(this,o.u),this.h=o.h,co(this,ju(o.i)),this.m=o.m):o&&(l=String(o).match(Mu))?(this.l=!1,wr(this,l[1]||"",!0),this.o=vr(l[2]||""),this.g=vr(l[3]||"",!0),Ar(this,l[4]),this.h=vr(l[5]||"",!0),co(this,l[6]||"",!0),this.m=vr(l[7]||"")):(this.l=!1,this.i=new Pr(null,this.l))}ge.prototype.toString=function(){const o=[];var l=this.j;l&&o.push(Rr(l,Ou,!0),":");var d=this.g;return(d||l=="file")&&(o.push("//"),(l=this.o)&&o.push(Rr(l,Ou,!0),"@"),o.push(Tr(d).replace(/%25([0-9a-fA-F]{2})/g,"%$1")),d=this.u,d!=null&&o.push(":",String(d))),(d=this.h)&&(this.g&&d.charAt(0)!="/"&&o.push("/"),o.push(Rr(d,d.charAt(0)=="/"?Hf:Wf,!0))),(d=this.i.toString())&&o.push("?",d),(d=this.m)&&o.push("#",Rr(d,Yf)),o.join("")},ge.prototype.resolve=function(o){const l=Wt(this);let d=!!o.j;d?wr(l,o.j):d=!!o.o,d?l.o=o.o:d=!!o.g,d?l.g=o.g:d=o.u!=null;var g=o.h;if(d)Ar(l,o.u);else if(d=!!o.h){if(g.charAt(0)!="/")if(this.g&&!this.h)g="/"+g;else{var R=l.h.lastIndexOf("/");R!=-1&&(g=l.h.slice(0,R+1)+g)}if(R=g,R==".."||R==".")g="";else if(R.indexOf("./")!=-1||R.indexOf("/.")!=-1){g=R.lastIndexOf("/",0)==0,R=R.split("/");const V=[];for(let M=0;M<R.length;){const K=R[M++];K=="."?g&&M==R.length&&V.push(""):K==".."?((V.length>1||V.length==1&&V[0]!="")&&V.pop(),g&&M==R.length&&V.push("")):(V.push(K),g=!0)}g=V.join("/")}else g=R}return d?l.h=g:d=o.i.toString()!=="",d?co(l,ju(o.i)):d=!!o.m,d&&(l.m=o.m),l};function Wt(o){return new ge(o)}function wr(o,l,d){o.j=d?vr(l,!0):l,o.j&&(o.j=o.j.replace(/:$/,""))}function Ar(o,l){if(l){if(l=Number(l),isNaN(l)||l<0)throw Error("Bad port number "+l);o.u=l}else o.u=null}function co(o,l,d){l instanceof Pr?(o.i=l,Xf(o.i,o.l)):(d||(l=Rr(l,Jf)),o.i=new Pr(l,o.l))}function ot(o,l,d){o.i.set(l,d)}function xs(o){return ot(o,"zx",Math.floor(Math.random()*2147483648).toString(36)+Math.abs(Math.floor(Math.random()*2147483648)^Date.now()).toString(36)),o}function vr(o,l){return o?l?decodeURI(o.replace(/%25/g,"%2525")):decodeURIComponent(o):""}function Rr(o,l,d){return typeof o=="string"?(o=encodeURI(o).replace(l,Qf),d&&(o=o.replace(/%25([0-9a-fA-F]{2})/g,"%$1")),o):null}function Qf(o){return o=o.charCodeAt(0),"%"+(o>>4&15).toString(16)+(o&15).toString(16)}var Ou=/[#\/\?@]/g,Wf=/[#\?:]/g,Hf=/[#\?]/g,Jf=/[#\?@]/g,Yf=/#/g;function Pr(o,l){this.h=this.g=null,this.i=o||null,this.j=!!l}function $e(o){o.g||(o.g=new Map,o.h=0,o.i&&$f(o.i,function(l,d){o.add(decodeURIComponent(l.replace(/\+/g," ")),d)}))}r=Pr.prototype,r.add=function(o,l){$e(this),this.i=null,o=An(this,o);let d=this.g.get(o);return d||this.g.set(o,d=[]),d.push(l),this.h+=1,this};function Lu(o,l){$e(o),l=An(o,l),o.g.has(l)&&(o.i=null,o.h-=o.g.get(l).length,o.g.delete(l))}function qu(o,l){return $e(o),l=An(o,l),o.g.has(l)}r.forEach=function(o,l){$e(this),this.g.forEach(function(d,g){d.forEach(function(R){o.call(l,R,g,this)},this)},this)};function Bu(o,l){$e(o);let d=[];if(typeof l=="string")qu(o,l)&&(d=d.concat(o.g.get(An(o,l))));else for(o=Array.from(o.g.values()),l=0;l<o.length;l++)d=d.concat(o[l]);return d}r.set=function(o,l){return $e(this),this.i=null,o=An(this,o),qu(this,o)&&(this.h-=this.g.get(o).length),this.g.set(o,[l]),this.h+=1,this},r.get=function(o,l){return o?(o=Bu(this,o),o.length>0?String(o[0]):l):l};function Uu(o,l,d){Lu(o,l),d.length>0&&(o.i=null,o.g.set(An(o,l),v(d)),o.h+=d.length)}r.toString=function(){if(this.i)return this.i;if(!this.g)return"";const o=[],l=Array.from(this.g.keys());for(let g=0;g<l.length;g++){var d=l[g];const R=Tr(d);d=Bu(this,d);for(let V=0;V<d.length;V++){let M=R;d[V]!==""&&(M+="="+Tr(d[V])),o.push(M)}}return this.i=o.join("&")};function ju(o){const l=new Pr;return l.i=o.i,o.g&&(l.g=new Map(o.g),l.h=o.h),l}function An(o,l){return l=String(l),o.j&&(l=l.toLowerCase()),l}function Xf(o,l){l&&!o.j&&($e(o),o.i=null,o.g.forEach(function(d,g){const R=g.toLowerCase();g!=R&&(Lu(this,g),Uu(this,R,d))},o)),o.j=l}function Zf(o,l){const d=new Ir;if(a.Image){const g=new Image;g.onload=f(pe,d,"TestLoadImage: loaded",!0,l,g),g.onerror=f(pe,d,"TestLoadImage: error",!1,l,g),g.onabort=f(pe,d,"TestLoadImage: abort",!1,l,g),g.ontimeout=f(pe,d,"TestLoadImage: timeout",!1,l,g),a.setTimeout(function(){g.ontimeout&&g.ontimeout()},1e4),g.src=o}else l(!1)}function tm(o,l){const d=new Ir,g=new AbortController,R=setTimeout(()=>{g.abort(),pe(d,"TestPingServer: timeout",!1,l)},1e4);fetch(o,{signal:g.signal}).then(V=>{clearTimeout(R),V.ok?pe(d,"TestPingServer: ok",!0,l):pe(d,"TestPingServer: server error",!1,l)}).catch(()=>{clearTimeout(R),pe(d,"TestPingServer: error",!1,l)})}function pe(o,l,d,g,R){try{R&&(R.onload=null,R.onerror=null,R.onabort=null,R.ontimeout=null),g(d)}catch{}}function em(){this.g=new Of}function lo(o){this.i=o.Sb||null,this.h=o.ab||!1}m(lo,yu),lo.prototype.g=function(){return new Ds(this.i,this.h)};function Ds(o,l){Vt.call(this),this.H=o,this.o=l,this.m=void 0,this.status=this.readyState=0,this.responseType=this.responseText=this.response=this.statusText="",this.onreadystatechange=null,this.A=new Headers,this.h=null,this.F="GET",this.D="",this.g=!1,this.B=this.j=this.l=null,this.v=new AbortController}m(Ds,Vt),r=Ds.prototype,r.open=function(o,l){if(this.readyState!=0)throw this.abort(),Error("Error reopening a connection");this.F=o,this.D=l,this.readyState=1,Vr(this)},r.send=function(o){if(this.readyState!=1)throw this.abort(),Error("need to call open() first. ");if(this.v.signal.aborted)throw this.abort(),Error("Request was aborted.");this.g=!0;const l={headers:this.A,method:this.F,credentials:this.m,cache:void 0,signal:this.v.signal};o&&(l.body=o),(this.H||a).fetch(new Request(this.D,l)).then(this.Pa.bind(this),this.ga.bind(this))},r.abort=function(){this.response=this.responseText="",this.A=new Headers,this.status=0,this.v.abort(),this.j&&this.j.cancel("Request was aborted.").catch(()=>{}),this.readyState>=1&&this.g&&this.readyState!=4&&(this.g=!1,Sr(this)),this.readyState=0},r.Pa=function(o){if(this.g&&(this.l=o,this.h||(this.status=this.l.status,this.statusText=this.l.statusText,this.h=o.headers,this.readyState=2,Vr(this)),this.g&&(this.readyState=3,Vr(this),this.g)))if(this.responseType==="arraybuffer")o.arrayBuffer().then(this.Na.bind(this),this.ga.bind(this));else if(typeof a.ReadableStream<"u"&&"body"in o){if(this.j=o.body.getReader(),this.o){if(this.responseType)throw Error('responseType must be empty for "streamBinaryChunks" mode responses.');this.response=[]}else this.response=this.responseText="",this.B=new TextDecoder;zu(this)}else o.text().then(this.Oa.bind(this),this.ga.bind(this))};function zu(o){o.j.read().then(o.Ma.bind(o)).catch(o.ga.bind(o))}r.Ma=function(o){if(this.g){if(this.o&&o.value)this.response.push(o.value);else if(!this.o){var l=o.value?o.value:new Uint8Array(0);(l=this.B.decode(l,{stream:!o.done}))&&(this.response=this.responseText+=l)}o.done?Sr(this):Vr(this),this.readyState==3&&zu(this)}},r.Oa=function(o){this.g&&(this.response=this.responseText=o,Sr(this))},r.Na=function(o){this.g&&(this.response=o,Sr(this))},r.ga=function(){this.g&&Sr(this)};function Sr(o){o.readyState=4,o.l=null,o.j=null,o.B=null,Vr(o)}r.setRequestHeader=function(o,l){this.A.append(o,l)},r.getResponseHeader=function(o){return this.h&&this.h.get(o.toLowerCase())||""},r.getAllResponseHeaders=function(){if(!this.h)return"";const o=[],l=this.h.entries();for(var d=l.next();!d.done;)d=d.value,o.push(d[0]+": "+d[1]),d=l.next();return o.join(`\r
`)};function Vr(o){o.onreadystatechange&&o.onreadystatechange.call(o)}Object.defineProperty(Ds.prototype,"withCredentials",{get:function(){return this.m==="include"},set:function(o){this.m=o?"include":"same-origin"}});function Gu(o){let l="";return Rs(o,function(d,g){l+=g,l+=":",l+=d,l+=`\r
`}),l}function ho(o,l,d){t:{for(g in d){var g=!1;break t}g=!0}g||(d=Gu(d),typeof o=="string"?d!=null&&Tr(d):ot(o,l,d))}function dt(o){Vt.call(this),this.headers=new Map,this.L=o||null,this.h=!1,this.g=null,this.D="",this.o=0,this.l="",this.j=this.B=this.v=this.A=!1,this.m=null,this.F="",this.H=!1}m(dt,Vt);var nm=/^https?$/i,rm=["POST","PUT"];r=dt.prototype,r.Fa=function(o){this.H=o},r.ea=function(o,l,d,g){if(this.g)throw Error("[goog.net.XhrIo] Object is active with another request="+this.D+"; newUri="+o);l=l?l.toUpperCase():"GET",this.D=o,this.l="",this.o=0,this.A=!1,this.h=!0,this.g=this.L?this.L.g():Ru.g(),this.g.onreadystatechange=p(h(this.Ca,this));try{this.B=!0,this.g.open(l,String(o),!0),this.B=!1}catch(V){Ku(this,V);return}if(o=d||"",d=new Map(this.headers),g)if(Object.getPrototypeOf(g)===Object.prototype)for(var R in g)d.set(R,g[R]);else if(typeof g.keys=="function"&&typeof g.get=="function")for(const V of g.keys())d.set(V,g.get(V));else throw Error("Unknown input type for opt_headers: "+String(g));g=Array.from(d.keys()).find(V=>V.toLowerCase()=="content-type"),R=a.FormData&&o instanceof a.FormData,!(Array.prototype.indexOf.call(rm,l,void 0)>=0)||g||R||d.set("Content-Type","application/x-www-form-urlencoded;charset=utf-8");for(const[V,M]of d)this.g.setRequestHeader(V,M);this.F&&(this.g.responseType=this.F),"withCredentials"in this.g&&this.g.withCredentials!==this.H&&(this.g.withCredentials=this.H);try{this.m&&(clearTimeout(this.m),this.m=null),this.v=!0,this.g.send(o),this.v=!1}catch(V){Ku(this,V)}};function Ku(o,l){o.h=!1,o.g&&(o.j=!0,o.g.abort(),o.j=!1),o.l=l,o.o=5,$u(o),Ns(o)}function $u(o){o.A||(o.A=!0,Nt(o,"complete"),Nt(o,"error"))}r.abort=function(o){this.g&&this.h&&(this.h=!1,this.j=!0,this.g.abort(),this.j=!1,this.o=o||7,Nt(this,"complete"),Nt(this,"abort"),Ns(this))},r.N=function(){this.g&&(this.h&&(this.h=!1,this.j=!0,this.g.abort(),this.j=!1),Ns(this,!0)),dt.Z.N.call(this)},r.Ca=function(){this.u||(this.B||this.v||this.j?Qu(this):this.Xa())},r.Xa=function(){Qu(this)};function Qu(o){if(o.h&&typeof i<"u"){if(o.v&&_e(o)==4)setTimeout(o.Ca.bind(o),0);else if(Nt(o,"readystatechange"),_e(o)==4){o.h=!1;try{const V=o.ca();t:switch(V){case 200:case 201:case 202:case 204:case 206:case 304:case 1223:var l=!0;break t;default:l=!1}var d;if(!(d=l)){var g;if(g=V===0){let M=String(o.D).match(Mu)[1]||null;!M&&a.self&&a.self.location&&(M=a.self.location.protocol.slice(0,-1)),g=!nm.test(M?M.toLowerCase():"")}d=g}if(d)Nt(o,"complete"),Nt(o,"success");else{o.o=6;try{var R=_e(o)>2?o.g.statusText:""}catch{R=""}o.l=R+" ["+o.ca()+"]",$u(o)}}finally{Ns(o)}}}}function Ns(o,l){if(o.g){o.m&&(clearTimeout(o.m),o.m=null);const d=o.g;o.g=null,l||Nt(o,"ready");try{d.onreadystatechange=null}catch{}}}r.isActive=function(){return!!this.g};function _e(o){return o.g?o.g.readyState:0}r.ca=function(){try{return _e(this)>2?this.g.status:-1}catch{return-1}},r.la=function(){try{return this.g?this.g.responseText:""}catch{return""}},r.La=function(o){if(this.g){var l=this.g.responseText;return o&&l.indexOf(o)==0&&(l=l.substring(o.length)),Mf(l)}};function Wu(o){try{if(!o.g)return null;if("response"in o.g)return o.g.response;switch(o.F){case"":case"text":return o.g.responseText;case"arraybuffer":if("mozResponseArrayBuffer"in o.g)return o.g.mozResponseArrayBuffer}return null}catch{return null}}function sm(o){const l={};o=(o.g&&_e(o)>=2&&o.g.getAllResponseHeaders()||"").split(`\r
`);for(let g=0;g<o.length;g++){if(y(o[g]))continue;var d=jf(o[g]);const R=d[0];if(d=d[1],typeof d!="string")continue;d=d.trim();const V=l[R]||[];l[R]=V,V.push(d)}Cf(l,function(g){return g.join(", ")})}r.ya=function(){return this.o},r.Ha=function(){return typeof this.l=="string"?this.l:String(this.l)};function br(o,l,d){return d&&d.internalChannelParams&&d.internalChannelParams[o]||l}function Hu(o){this.za=0,this.i=[],this.j=new Ir,this.ba=this.na=this.J=this.W=this.g=this.wa=this.G=this.H=this.u=this.U=this.o=null,this.Ya=this.V=0,this.Sa=br("failFast",!1,o),this.F=this.C=this.v=this.m=this.l=null,this.X=!0,this.xa=this.K=-1,this.Y=this.A=this.D=0,this.Qa=br("baseRetryDelayMs",5e3,o),this.Za=br("retryDelaySeedMs",1e4,o),this.Ta=br("forwardChannelMaxRetries",2,o),this.va=br("forwardChannelRequestTimeoutMs",2e4,o),this.ma=o&&o.xmlHttpFactory||void 0,this.Ua=o&&o.Rb||void 0,this.Aa=o&&o.useFetchStreams||!1,this.O=void 0,this.L=o&&o.supportsCrossDomainXhr||!1,this.M="",this.h=new xu(o&&o.concurrentRequestLimit),this.Ba=new em,this.S=o&&o.fastHandshake||!1,this.R=o&&o.encodeInitMessageHeaders||!1,this.S&&this.R&&(this.R=!1),this.Ra=o&&o.Pb||!1,o&&o.ua&&this.j.ua(),o&&o.forceLongPolling&&(this.X=!1),this.aa=!this.S&&this.X&&o&&o.detectBufferingProxy||!1,this.ia=void 0,o&&o.longPollingTimeout&&o.longPollingTimeout>0&&(this.ia=o.longPollingTimeout),this.ta=void 0,this.T=0,this.P=!1,this.ja=this.B=null}r=Hu.prototype,r.ka=8,r.I=1,r.connect=function(o,l,d,g){kt(0),this.W=o,this.H=l||{},d&&g!==void 0&&(this.H.OSID=d,this.H.OAID=g),this.F=this.X,this.J=sc(this,null,this.W),Fs(this)};function fo(o){if(Ju(o),o.I==3){var l=o.V++,d=Wt(o.J);if(ot(d,"SID",o.M),ot(d,"RID",l),ot(d,"TYPE","terminate"),Cr(o,d),l=new me(o,o.j,l),l.M=2,l.A=xs(Wt(d)),d=!1,a.navigator&&a.navigator.sendBeacon)try{d=a.navigator.sendBeacon(l.A.toString(),"")}catch{}!d&&a.Image&&(new Image().src=l.A,d=!0),d||(l.g=ic(l.j,null),l.g.ea(l.A)),l.F=Date.now(),Cs(l)}rc(o)}function ks(o){o.g&&(go(o),o.g.cancel(),o.g=null)}function Ju(o){ks(o),o.v&&(a.clearTimeout(o.v),o.v=null),Ms(o),o.h.cancel(),o.m&&(typeof o.m=="number"&&a.clearTimeout(o.m),o.m=null)}function Fs(o){if(!Du(o.h)&&!o.m){o.m=!0;var l=o.Ea;J||_(),Y||(J(),Y=!0),T.add(l,o),o.D=0}}function im(o,l){return Nu(o.h)>=o.h.j-(o.m?1:0)?!1:o.m?(o.i=l.G.concat(o.i),!0):o.I==1||o.I==2||o.D>=(o.Sa?0:o.Ta)?!1:(o.m=yr(h(o.Ea,o,l),nc(o,o.D)),o.D++,!0)}r.Ea=function(o){if(this.m)if(this.m=null,this.I==1){if(!o){this.V=Math.floor(Math.random()*1e5),o=this.V++;const R=new me(this,this.j,o);let V=this.o;if(this.U&&(V?(V=uu(V),lu(V,this.U)):V=this.U),this.u!==null||this.R||(R.J=V,V=null),this.S)t:{for(var l=0,d=0;d<this.i.length;d++){e:{var g=this.i[d];if("__data__"in g.map&&(g=g.map.__data__,typeof g=="string")){g=g.length;break e}g=void 0}if(g===void 0)break;if(l+=g,l>4096){l=d;break t}if(l===4096||d===this.i.length-1){l=d+1;break t}}l=1e3}else l=1e3;l=Xu(this,R,l),d=Wt(this.J),ot(d,"RID",o),ot(d,"CVER",22),this.G&&ot(d,"X-HTTP-Session-Id",this.G),Cr(this,d),V&&(this.R?l="headers="+Tr(Gu(V))+"&"+l:this.u&&ho(d,this.u,V)),uo(this.h,R),this.Ra&&ot(d,"TYPE","init"),this.S?(ot(d,"$req",l),ot(d,"SID","null"),R.U=!0,so(R,d,null)):so(R,d,l),this.I=2}}else this.I==3&&(o?Yu(this,o):this.i.length==0||Du(this.h)||Yu(this))};function Yu(o,l){var d;l?d=l.l:d=o.V++;const g=Wt(o.J);ot(g,"SID",o.M),ot(g,"RID",d),ot(g,"AID",o.K),Cr(o,g),o.u&&o.o&&ho(g,o.u,o.o),d=new me(o,o.j,d,o.D+1),o.u===null&&(d.J=o.o),l&&(o.i=l.G.concat(o.i)),l=Xu(o,d,1e3),d.H=Math.round(o.va*.5)+Math.round(o.va*.5*Math.random()),uo(o.h,d),so(d,g,l)}function Cr(o,l){o.H&&Rs(o.H,function(d,g){ot(l,g,d)}),o.l&&Rs({},function(d,g){ot(l,g,d)})}function Xu(o,l,d){d=Math.min(o.i.length,d);const g=o.l?h(o.l.Ka,o.l,o):null;t:{var R=o.i;let K=-1;for(;;){const yt=["count="+d];K==-1?d>0?(K=R[0].g,yt.push("ofs="+K)):K=0:yt.push("ofs="+K);let rt=!0;for(let Et=0;Et<d;Et++){var V=R[Et].g;const Ht=R[Et].map;if(V-=K,V<0)K=Math.max(0,R[Et].g-100),rt=!1;else try{V="req"+V+"_"||"";try{var M=Ht instanceof Map?Ht:Object.entries(Ht);for(const[We,ye]of M){let Ie=ye;u(ye)&&(Ie=Zi(ye)),yt.push(V+We+"="+encodeURIComponent(Ie))}}catch(We){throw yt.push(V+"type="+encodeURIComponent("_badmap")),We}}catch{g&&g(Ht)}}if(rt){M=yt.join("&");break t}}M=void 0}return o=o.i.splice(0,d),l.G=o,M}function Zu(o){if(!o.g&&!o.v){o.Y=1;var l=o.Da;J||_(),Y||(J(),Y=!0),T.add(l,o),o.A=0}}function mo(o){return o.g||o.v||o.A>=3?!1:(o.Y++,o.v=yr(h(o.Da,o),nc(o,o.A)),o.A++,!0)}r.Da=function(){if(this.v=null,tc(this),this.aa&&!(this.P||this.g==null||this.T<=0)){var o=4*this.T;this.j.info("BP detection timer enabled: "+o),this.B=yr(h(this.Wa,this),o)}},r.Wa=function(){this.B&&(this.B=null,this.j.info("BP detection timeout reached."),this.j.info("Buffering proxy detected and switch to long-polling!"),this.F=!1,this.P=!0,kt(10),ks(this),tc(this))};function go(o){o.B!=null&&(a.clearTimeout(o.B),o.B=null)}function tc(o){o.g=new me(o,o.j,"rpc",o.Y),o.u===null&&(o.g.J=o.o),o.g.P=0;var l=Wt(o.na);ot(l,"RID","rpc"),ot(l,"SID",o.M),ot(l,"AID",o.K),ot(l,"CI",o.F?"0":"1"),!o.F&&o.ia&&ot(l,"TO",o.ia),ot(l,"TYPE","xmlhttp"),Cr(o,l),o.u&&o.o&&ho(l,o.u,o.o),o.O&&(o.g.H=o.O);var d=o.g;o=o.ba,d.M=1,d.A=xs(Wt(l)),d.u=null,d.R=!0,Vu(d,o)}r.Va=function(){this.C!=null&&(this.C=null,ks(this),mo(this),kt(19))};function Ms(o){o.C!=null&&(a.clearTimeout(o.C),o.C=null)}function ec(o,l){var d=null;if(o.g==l){Ms(o),go(o),o.g=null;var g=2}else if(ao(o.h,l))d=l.G,ku(o.h,l),g=1;else return;if(o.I!=0){if(l.o)if(g==1){d=l.u?l.u.length:0,l=Date.now()-l.F;var R=o.D;g=Vs(),Nt(g,new Au(g,d)),Fs(o)}else Zu(o);else if(R=l.m,R==3||R==0&&l.X>0||!(g==1&&im(o,l)||g==2&&mo(o)))switch(d&&d.length>0&&(l=o.h,l.i=l.i.concat(d)),R){case 1:Qe(o,5);break;case 4:Qe(o,10);break;case 3:Qe(o,6);break;default:Qe(o,2)}}}function nc(o,l){let d=o.Qa+Math.floor(Math.random()*o.Za);return o.isActive()||(d*=2),d*l}function Qe(o,l){if(o.j.info("Error code "+l),l==2){var d=h(o.bb,o),g=o.Ua;const R=!g;g=new ge(g||"//www.google.com/images/cleardot.gif"),a.location&&a.location.protocol=="http"||wr(g,"https"),xs(g),R?Zf(g.toString(),d):tm(g.toString(),d)}else kt(2);o.I=0,o.l&&o.l.pa(l),rc(o),Ju(o)}r.bb=function(o){o?(this.j.info("Successfully pinged google.com"),kt(2)):(this.j.info("Failed to ping google.com"),kt(1))};function rc(o){if(o.I=0,o.ja=[],o.l){const l=Fu(o.h);(l.length!=0||o.i.length!=0)&&(C(o.ja,l),C(o.ja,o.i),o.h.i.length=0,v(o.i),o.i.length=0),o.l.oa()}}function sc(o,l,d){var g=d instanceof ge?Wt(d):new ge(d);if(g.g!="")l&&(g.g=l+"."+g.g),Ar(g,g.u);else{var R=a.location;g=R.protocol,l=l?l+"."+R.hostname:R.hostname,R=+R.port;const V=new ge(null);g&&wr(V,g),l&&(V.g=l),R&&Ar(V,R),d&&(V.h=d),g=V}return d=o.G,l=o.wa,d&&l&&ot(g,d,l),ot(g,"VER",o.ka),Cr(o,g),g}function ic(o,l,d){if(l&&!o.L)throw Error("Can't create secondary domain capable XhrIo object.");return l=o.Aa&&!o.ma?new dt(new lo({ab:d})):new dt(o.ma),l.Fa(o.L),l}r.isActive=function(){return!!this.l&&this.l.isActive(this)};function oc(){}r=oc.prototype,r.ra=function(){},r.qa=function(){},r.pa=function(){},r.oa=function(){},r.isActive=function(){return!0},r.Ka=function(){};function Os(){}Os.prototype.g=function(o,l){return new qt(o,l)};function qt(o,l){Vt.call(this),this.g=new Hu(l),this.l=o,this.h=l&&l.messageUrlParams||null,o=l&&l.messageHeaders||null,l&&l.clientProtocolHeaderRequired&&(o?o["X-Client-Protocol"]="webchannel":o={"X-Client-Protocol":"webchannel"}),this.g.o=o,o=l&&l.initMessageHeaders||null,l&&l.messageContentType&&(o?o["X-WebChannel-Content-Type"]=l.messageContentType:o={"X-WebChannel-Content-Type":l.messageContentType}),l&&l.sa&&(o?o["X-WebChannel-Client-Profile"]=l.sa:o={"X-WebChannel-Client-Profile":l.sa}),this.g.U=o,(o=l&&l.Qb)&&!y(o)&&(this.g.u=o),this.A=l&&l.supportsCrossDomainXhr||!1,this.v=l&&l.sendRawJson||!1,(l=l&&l.httpSessionIdParam)&&!y(l)&&(this.g.G=l,o=this.h,o!==null&&l in o&&(o=this.h,l in o&&delete o[l])),this.j=new vn(this)}m(qt,Vt),qt.prototype.m=function(){this.g.l=this.j,this.A&&(this.g.L=!0),this.g.connect(this.l,this.h||void 0)},qt.prototype.close=function(){fo(this.g)},qt.prototype.o=function(o){var l=this.g;if(typeof o=="string"){var d={};d.__data__=o,o=d}else this.v&&(d={},d.__data__=Zi(o),o=d);l.i.push(new Kf(l.Ya++,o)),l.I==3&&Fs(l)},qt.prototype.N=function(){this.g.l=null,delete this.j,fo(this.g),delete this.g,qt.Z.N.call(this)};function ac(o){to.call(this),o.__headers__&&(this.headers=o.__headers__,this.statusCode=o.__status__,delete o.__headers__,delete o.__status__);var l=o.__sm__;if(l){t:{for(const d in l){o=d;break t}o=void 0}(this.i=o)&&(o=this.i,l=l!==null&&o in l?l[o]:void 0),this.data=l}else this.data=o}m(ac,to);function uc(){eo.call(this),this.status=1}m(uc,eo);function vn(o){this.g=o}m(vn,oc),vn.prototype.ra=function(){Nt(this.g,"a")},vn.prototype.qa=function(o){Nt(this.g,new ac(o))},vn.prototype.pa=function(o){Nt(this.g,new uc)},vn.prototype.oa=function(){Nt(this.g,"b")},Os.prototype.createWebChannel=Os.prototype.g,qt.prototype.send=qt.prototype.o,qt.prototype.open=qt.prototype.m,qt.prototype.close=qt.prototype.close,Kl=function(){return new Os},Gl=function(){return Vs()},zl=Ge,Po={jb:0,mb:1,nb:2,Hb:3,Mb:4,Jb:5,Kb:6,Ib:7,Gb:8,Lb:9,PROXY:10,NOPROXY:11,Eb:12,Ab:13,Bb:14,zb:15,Cb:16,Db:17,fb:18,eb:19,gb:20},bs.NO_ERROR=0,bs.TIMEOUT=8,bs.HTTP_ERROR=6,Qs=bs,vu.COMPLETE="complete",jl=vu,Iu.EventType=pr,pr.OPEN="a",pr.CLOSE="b",pr.ERROR="c",pr.MESSAGE="d",Vt.prototype.listen=Vt.prototype.J,Or=Iu,dt.prototype.listenOnce=dt.prototype.K,dt.prototype.getLastError=dt.prototype.Ha,dt.prototype.getLastErrorCode=dt.prototype.ya,dt.prototype.getStatus=dt.prototype.ca,dt.prototype.getResponseJson=dt.prototype.La,dt.prototype.getResponseText=dt.prototype.la,dt.prototype.send=dt.prototype.ea,dt.prototype.setWithCredentials=dt.prototype.Fa,Ul=dt}).apply(typeof qs<"u"?qs:typeof self<"u"?self:typeof window<"u"?window:{});/**
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
 */class At{constructor(t){this.uid=t}isAuthenticated(){return this.uid!=null}toKey(){return this.isAuthenticated()?"uid:"+this.uid:"anonymous-user"}isEqual(t){return t.uid===this.uid}}At.UNAUTHENTICATED=new At(null),At.GOOGLE_CREDENTIALS=new At("google-credentials-uid"),At.FIRST_PARTY=new At("first-party-uid"),At.MOCK_USER=new At("mock-user");/**
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
 */let sr="12.9.0";function Im(r){sr=r}/**
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
 *//**
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
 */const Ce=new am("@firebase/firestore");function xn(){return Ce.logLevel}function wy(r){Ce.setLogLevel(r)}function x(r,...t){if(Ce.logLevel<=ie.DEBUG){const e=t.map(ta);Ce.debug(`Firestore (${sr}): ${r}`,...e)}}function mt(r,...t){if(Ce.logLevel<=ie.ERROR){const e=t.map(ta);Ce.error(`Firestore (${sr}): ${r}`,...e)}}function Gt(r,...t){if(Ce.logLevel<=ie.WARN){const e=t.map(ta);Ce.warn(`Firestore (${sr}): ${r}`,...e)}}function ta(r){if(typeof r=="string")return r;try{return(function(e){return JSON.stringify(e)})(r)}catch{return r}}/**
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
 */function O(r,t,e){let n="Unexpected state";typeof t=="string"?n=t:e=t,$l(r,n,e)}function $l(r,t,e){let n=`FIRESTORE (${sr}) INTERNAL ASSERTION FAILED: ${t} (ID: ${r.toString(16)})`;if(e!==void 0)try{n+=" CONTEXT: "+JSON.stringify(e)}catch{n+=" CONTEXT: "+e}throw mt(n),new Error(n)}function L(r,t,e,n){let s="Unexpected state";typeof e=="string"?s=e:n=e,r||$l(t,s,n)}function Ay(r,t){r||O(57014,t)}function F(r,t){return r}/**
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
 */const P={OK:"ok",CANCELLED:"cancelled",UNKNOWN:"unknown",INVALID_ARGUMENT:"invalid-argument",DEADLINE_EXCEEDED:"deadline-exceeded",NOT_FOUND:"not-found",ALREADY_EXISTS:"already-exists",PERMISSION_DENIED:"permission-denied",UNAUTHENTICATED:"unauthenticated",RESOURCE_EXHAUSTED:"resource-exhausted",FAILED_PRECONDITION:"failed-precondition",ABORTED:"aborted",OUT_OF_RANGE:"out-of-range",UNIMPLEMENTED:"unimplemented",INTERNAL:"internal",UNAVAILABLE:"unavailable",DATA_LOSS:"data-loss"};class b extends om{constructor(t,e){super(t,e),this.code=t,this.message=e,this.toString=()=>`${this.name}: [code=${this.code}]: ${this.message}`}}/**
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
 */class Rt{constructor(){this.promise=new Promise(((t,e)=>{this.resolve=t,this.reject=e}))}}/**
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
 */class Ql{constructor(t,e){this.user=e,this.type="OAuth",this.headers=new Map,this.headers.set("Authorization",`Bearer ${t}`)}}class Tm{getToken(){return Promise.resolve(null)}invalidateToken(){}start(t,e){t.enqueueRetryable((()=>e(At.UNAUTHENTICATED)))}shutdown(){}}class Em{constructor(t){this.token=t,this.changeListener=null}getToken(){return Promise.resolve(this.token)}invalidateToken(){}start(t,e){this.changeListener=e,t.enqueueRetryable((()=>e(this.token.user)))}shutdown(){this.changeListener=null}}class wm{constructor(t){this.t=t,this.currentUser=At.UNAUTHENTICATED,this.i=0,this.forceRefresh=!1,this.auth=null}start(t,e){L(this.o===void 0,42304);let n=this.i;const s=c=>this.i!==n?(n=this.i,e(c)):Promise.resolve();let i=new Rt;this.o=()=>{this.i++,this.currentUser=this.u(),i.resolve(),i=new Rt,t.enqueueRetryable((()=>s(this.currentUser)))};const a=()=>{const c=i;t.enqueueRetryable((async()=>{await c.promise,await s(this.currentUser)}))},u=c=>{x("FirebaseAuthCredentialsProvider","Auth detected"),this.auth=c,this.o&&(this.auth.addAuthTokenListener(this.o),a())};this.t.onInit((c=>u(c))),setTimeout((()=>{if(!this.auth){const c=this.t.getImmediate({optional:!0});c?u(c):(x("FirebaseAuthCredentialsProvider","Auth not yet detected"),i.resolve(),i=new Rt)}}),0),a()}getToken(){const t=this.i,e=this.forceRefresh;return this.forceRefresh=!1,this.auth?this.auth.getToken(e).then((n=>this.i!==t?(x("FirebaseAuthCredentialsProvider","getToken aborted due to token change."),this.getToken()):n?(L(typeof n.accessToken=="string",31837,{l:n}),new Ql(n.accessToken,this.currentUser)):null)):Promise.resolve(null)}invalidateToken(){this.forceRefresh=!0}shutdown(){this.auth&&this.o&&this.auth.removeAuthTokenListener(this.o),this.o=void 0}u(){const t=this.auth&&this.auth.getUid();return L(t===null||typeof t=="string",2055,{h:t}),new At(t)}}class Am{constructor(t,e,n){this.P=t,this.T=e,this.I=n,this.type="FirstParty",this.user=At.FIRST_PARTY,this.R=new Map}A(){return this.I?this.I():null}get headers(){this.R.set("X-Goog-AuthUser",this.P);const t=this.A();return t&&this.R.set("Authorization",t),this.T&&this.R.set("X-Goog-Iam-Authorization-Token",this.T),this.R}}class vm{constructor(t,e,n){this.P=t,this.T=e,this.I=n}getToken(){return Promise.resolve(new Am(this.P,this.T,this.I))}start(t,e){t.enqueueRetryable((()=>e(At.FIRST_PARTY)))}shutdown(){}invalidateToken(){}}class So{constructor(t){this.value=t,this.type="AppCheck",this.headers=new Map,t&&t.length>0&&this.headers.set("x-firebase-appcheck",this.value)}}class Rm{constructor(t,e){this.V=e,this.forceRefresh=!1,this.appCheck=null,this.m=null,this.p=null,gm(t)&&t.settings.appCheckToken&&(this.p=t.settings.appCheckToken)}start(t,e){L(this.o===void 0,3512);const n=i=>{i.error!=null&&x("FirebaseAppCheckTokenProvider",`Error getting App Check token; using placeholder token instead. Error: ${i.error.message}`);const a=i.token!==this.m;return this.m=i.token,x("FirebaseAppCheckTokenProvider",`Received ${a?"new":"existing"} token.`),a?e(i.token):Promise.resolve()};this.o=i=>{t.enqueueRetryable((()=>n(i)))};const s=i=>{x("FirebaseAppCheckTokenProvider","AppCheck detected"),this.appCheck=i,this.o&&this.appCheck.addTokenListener(this.o)};this.V.onInit((i=>s(i))),setTimeout((()=>{if(!this.appCheck){const i=this.V.getImmediate({optional:!0});i?s(i):x("FirebaseAppCheckTokenProvider","AppCheck not yet detected")}}),0)}getToken(){if(this.p)return Promise.resolve(new So(this.p));const t=this.forceRefresh;return this.forceRefresh=!1,this.appCheck?this.appCheck.getToken(t).then((e=>e?(L(typeof e.token=="string",44558,{tokenResult:e}),this.m=e.token,new So(e.token)):null)):Promise.resolve(null)}invalidateToken(){this.forceRefresh=!0}shutdown(){this.appCheck&&this.o&&this.appCheck.removeTokenListener(this.o),this.o=void 0}}class vy{getToken(){return Promise.resolve(new So(""))}invalidateToken(){}start(t,e){}shutdown(){}}/**
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
 */function Pm(r){const t=typeof self<"u"&&(self.crypto||self.msCrypto),e=new Uint8Array(r);if(t&&typeof t.getRandomValues=="function")t.getRandomValues(e);else for(let n=0;n<r;n++)e[n]=Math.floor(256*Math.random());return e}/**
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
 */class ea{static newId(){const t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",e=62*Math.floor(4.129032258064516);let n="";for(;n.length<20;){const s=Pm(40);for(let i=0;i<s.length;++i)n.length<20&&s[i]<e&&(n+=t.charAt(s[i]%62))}return n}}function z(r,t){return r<t?-1:r>t?1:0}function Vo(r,t){const e=Math.min(r.length,t.length);for(let n=0;n<e;n++){const s=r.charAt(n),i=t.charAt(n);if(s!==i)return _o(s)===_o(i)?z(s,i):_o(s)?1:-1}return z(r.length,t.length)}const Sm=55296,Vm=57343;function _o(r){const t=r.charCodeAt(0);return t>=Sm&&t<=Vm}function Ln(r,t,e){return r.length===t.length&&r.every(((n,s)=>e(n,t[s])))}function Wl(r){return r+"\0"}/**
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
 */const bo="__name__";class Jt{constructor(t,e,n){e===void 0?e=0:e>t.length&&O(637,{offset:e,range:t.length}),n===void 0?n=t.length-e:n>t.length-e&&O(1746,{length:n,range:t.length-e}),this.segments=t,this.offset=e,this.len=n}get length(){return this.len}isEqual(t){return Jt.comparator(this,t)===0}child(t){const e=this.segments.slice(this.offset,this.limit());return t instanceof Jt?t.forEach((n=>{e.push(n)})):e.push(t),this.construct(e)}limit(){return this.offset+this.length}popFirst(t){return t=t===void 0?1:t,this.construct(this.segments,this.offset+t,this.length-t)}popLast(){return this.construct(this.segments,this.offset,this.length-1)}firstSegment(){return this.segments[this.offset]}lastSegment(){return this.get(this.length-1)}get(t){return this.segments[this.offset+t]}isEmpty(){return this.length===0}isPrefixOf(t){if(t.length<this.length)return!1;for(let e=0;e<this.length;e++)if(this.get(e)!==t.get(e))return!1;return!0}isImmediateParentOf(t){if(this.length+1!==t.length)return!1;for(let e=0;e<this.length;e++)if(this.get(e)!==t.get(e))return!1;return!0}forEach(t){for(let e=this.offset,n=this.limit();e<n;e++)t(this.segments[e])}toArray(){return this.segments.slice(this.offset,this.limit())}static comparator(t,e){const n=Math.min(t.length,e.length);for(let s=0;s<n;s++){const i=Jt.compareSegments(t.get(s),e.get(s));if(i!==0)return i}return z(t.length,e.length)}static compareSegments(t,e){const n=Jt.isNumericId(t),s=Jt.isNumericId(e);return n&&!s?-1:!n&&s?1:n&&s?Jt.extractNumericId(t).compare(Jt.extractNumericId(e)):Vo(t,e)}static isNumericId(t){return t.startsWith("__id")&&t.endsWith("__")}static extractNumericId(t){return Ve.fromString(t.substring(4,t.length-2))}}class $ extends Jt{construct(t,e,n){return new $(t,e,n)}canonicalString(){return this.toArray().join("/")}toString(){return this.canonicalString()}toUriEncodedString(){return this.toArray().map(encodeURIComponent).join("/")}static fromString(...t){const e=[];for(const n of t){if(n.indexOf("//")>=0)throw new b(P.INVALID_ARGUMENT,`Invalid segment (${n}). Paths must not contain // in them.`);e.push(...n.split("/").filter((s=>s.length>0)))}return new $(e)}static emptyPath(){return new $([])}}const bm=/^[_a-zA-Z][_a-zA-Z0-9]*$/;class ct extends Jt{construct(t,e,n){return new ct(t,e,n)}static isValidIdentifier(t){return bm.test(t)}canonicalString(){return this.toArray().map((t=>(t=t.replace(/\\/g,"\\\\").replace(/`/g,"\\`"),ct.isValidIdentifier(t)||(t="`"+t+"`"),t))).join(".")}toString(){return this.canonicalString()}isKeyField(){return this.length===1&&this.get(0)===bo}static keyField(){return new ct([bo])}static fromServerFormat(t){const e=[];let n="",s=0;const i=()=>{if(n.length===0)throw new b(P.INVALID_ARGUMENT,`Invalid field path (${t}). Paths must not be empty, begin with '.', end with '.', or contain '..'`);e.push(n),n=""};let a=!1;for(;s<t.length;){const u=t[s];if(u==="\\"){if(s+1===t.length)throw new b(P.INVALID_ARGUMENT,"Path has trailing escape character: "+t);const c=t[s+1];if(c!=="\\"&&c!=="."&&c!=="`")throw new b(P.INVALID_ARGUMENT,"Path has invalid escape sequence: "+t);n+=c,s+=2}else u==="`"?(a=!a,s++):u!=="."||a?(n+=u,s++):(i(),s++)}if(i(),a)throw new b(P.INVALID_ARGUMENT,"Unterminated ` in path: "+t);return new ct(e)}static emptyPath(){return new ct([])}}/**
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
 */class k{constructor(t){this.path=t}static fromPath(t){return new k($.fromString(t))}static fromName(t){return new k($.fromString(t).popFirst(5))}static empty(){return new k($.emptyPath())}get collectionGroup(){return this.path.popLast().lastSegment()}hasCollectionId(t){return this.path.length>=2&&this.path.get(this.path.length-2)===t}getCollectionGroup(){return this.path.get(this.path.length-2)}getCollectionPath(){return this.path.popLast()}isEqual(t){return t!==null&&$.comparator(this.path,t.path)===0}toString(){return this.path.toString()}static comparator(t,e){return $.comparator(t.path,e.path)}static isDocumentKey(t){return t.length%2==0}static fromSegments(t){return new k(new $(t.slice()))}}/**
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
 */function na(r,t,e){if(!e)throw new b(P.INVALID_ARGUMENT,`Function ${r}() cannot be called with an empty ${t}.`)}function Cm(r,t,e,n){if(t===!0&&n===!0)throw new b(P.INVALID_ARGUMENT,`${r} and ${e} cannot be used together.`)}function hc(r){if(!k.isDocumentKey(r))throw new b(P.INVALID_ARGUMENT,`Invalid document reference. Document references must have an even number of segments, but ${r} has ${r.length}.`)}function dc(r){if(k.isDocumentKey(r))throw new b(P.INVALID_ARGUMENT,`Invalid collection reference. Collection references must have an odd number of segments, but ${r} has ${r.length}.`)}function Hl(r){return typeof r=="object"&&r!==null&&(Object.getPrototypeOf(r)===Object.prototype||Object.getPrototypeOf(r)===null)}function Ti(r){if(r===void 0)return"undefined";if(r===null)return"null";if(typeof r=="string")return r.length>20&&(r=`${r.substring(0,20)}...`),JSON.stringify(r);if(typeof r=="number"||typeof r=="boolean")return""+r;if(typeof r=="object"){if(r instanceof Array)return"an array";{const t=(function(n){return n.constructor?n.constructor.name:null})(r);return t?`a custom ${t} object`:"an object"}}return typeof r=="function"?"a function":O(12329,{type:typeof r})}function Q(r,t){if("_delegate"in r&&(r=r._delegate),!(r instanceof t)){if(t.name===r.constructor.name)throw new b(P.INVALID_ARGUMENT,"Type does not match the expected instance. Did you pass a reference from a different Firestore SDK?");{const e=Ti(r);throw new b(P.INVALID_ARGUMENT,`Expected type '${t.name}', but it was: ${e}`)}}return r}function Jl(r,t){if(t<=0)throw new b(P.INVALID_ARGUMENT,`Function ${r}() requires a positive number, but it was: ${t}.`)}/**
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
 */function _t(r,t){const e={typeString:r};return t&&(e.value=t),e}function _n(r,t){if(!Hl(r))throw new b(P.INVALID_ARGUMENT,"JSON must be an object");let e;for(const n in t)if(t[n]){const s=t[n].typeString,i="value"in t[n]?{value:t[n].value}:void 0;if(!(n in r)){e=`JSON missing required field: '${n}'`;break}const a=r[n];if(s&&typeof a!==s){e=`JSON field '${n}' must be a ${s}.`;break}if(i!==void 0&&a!==i.value){e=`Expected '${n}' field to equal '${i.value}'`;break}}if(e)throw new b(P.INVALID_ARGUMENT,e);return!0}/**
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
 */const fc=-62135596800,mc=1e6;class Z{static now(){return Z.fromMillis(Date.now())}static fromDate(t){return Z.fromMillis(t.getTime())}static fromMillis(t){const e=Math.floor(t/1e3),n=Math.floor((t-1e3*e)*mc);return new Z(e,n)}constructor(t,e){if(this.seconds=t,this.nanoseconds=e,e<0)throw new b(P.INVALID_ARGUMENT,"Timestamp nanoseconds out of range: "+e);if(e>=1e9)throw new b(P.INVALID_ARGUMENT,"Timestamp nanoseconds out of range: "+e);if(t<fc)throw new b(P.INVALID_ARGUMENT,"Timestamp seconds out of range: "+t);if(t>=253402300800)throw new b(P.INVALID_ARGUMENT,"Timestamp seconds out of range: "+t)}toDate(){return new Date(this.toMillis())}toMillis(){return 1e3*this.seconds+this.nanoseconds/mc}_compareTo(t){return this.seconds===t.seconds?z(this.nanoseconds,t.nanoseconds):z(this.seconds,t.seconds)}isEqual(t){return t.seconds===this.seconds&&t.nanoseconds===this.nanoseconds}toString(){return"Timestamp(seconds="+this.seconds+", nanoseconds="+this.nanoseconds+")"}toJSON(){return{type:Z._jsonSchemaVersion,seconds:this.seconds,nanoseconds:this.nanoseconds}}static fromJSON(t){if(_n(t,Z._jsonSchema))return new Z(t.seconds,t.nanoseconds)}valueOf(){const t=this.seconds-fc;return String(t).padStart(12,"0")+"."+String(this.nanoseconds).padStart(9,"0")}}Z._jsonSchemaVersion="firestore/timestamp/1.0",Z._jsonSchema={type:_t("string",Z._jsonSchemaVersion),seconds:_t("number"),nanoseconds:_t("number")};/**
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
 */class B{static fromTimestamp(t){return new B(t)}static min(){return new B(new Z(0,0))}static max(){return new B(new Z(253402300799,999999999))}constructor(t){this.timestamp=t}compareTo(t){return this.timestamp._compareTo(t.timestamp)}isEqual(t){return this.timestamp.isEqual(t.timestamp)}toMicroseconds(){return 1e6*this.timestamp.seconds+this.timestamp.nanoseconds/1e3}toString(){return"SnapshotVersion("+this.timestamp.toString()+")"}toTimestamp(){return this.timestamp}}/**
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
 */const qn=-1;class Bn{constructor(t,e,n,s){this.indexId=t,this.collectionGroup=e,this.fields=n,this.indexState=s}}function Co(r){return r.fields.find((t=>t.kind===2))}function Je(r){return r.fields.filter((t=>t.kind!==2))}function xm(r,t){let e=z(r.collectionGroup,t.collectionGroup);if(e!==0)return e;for(let n=0;n<Math.min(r.fields.length,t.fields.length);++n)if(e=Dm(r.fields[n],t.fields[n]),e!==0)return e;return z(r.fields.length,t.fields.length)}Bn.UNKNOWN_ID=-1;class rn{constructor(t,e){this.fieldPath=t,this.kind=e}}function Dm(r,t){const e=ct.comparator(r.fieldPath,t.fieldPath);return e!==0?e:z(r.kind,t.kind)}class Un{constructor(t,e){this.sequenceNumber=t,this.offset=e}static empty(){return new Un(0,Kt.min())}}function Yl(r,t){const e=r.toTimestamp().seconds,n=r.toTimestamp().nanoseconds+1,s=B.fromTimestamp(n===1e9?new Z(e+1,0):new Z(e,n));return new Kt(s,k.empty(),t)}function Xl(r){return new Kt(r.readTime,r.key,qn)}class Kt{constructor(t,e,n){this.readTime=t,this.documentKey=e,this.largestBatchId=n}static min(){return new Kt(B.min(),k.empty(),qn)}static max(){return new Kt(B.max(),k.empty(),qn)}}function ra(r,t){let e=r.readTime.compareTo(t.readTime);return e!==0?e:(e=k.comparator(r.documentKey,t.documentKey),e!==0?e:z(r.largestBatchId,t.largestBatchId))}/**
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
 */const Zl="The current tab is not in the required state to perform this operation. It might be necessary to refresh the browser tab.";class th{constructor(){this.onCommittedListeners=[]}addOnCommittedListener(t){this.onCommittedListeners.push(t)}raiseOnCommittedEvent(){this.onCommittedListeners.forEach((t=>t()))}}/**
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
 */async function Oe(r){if(r.code!==P.FAILED_PRECONDITION||r.message!==Zl)throw r;x("LocalStore","Unexpectedly lost primary lease")}/**
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
 */class A{constructor(t){this.nextCallback=null,this.catchCallback=null,this.result=void 0,this.error=void 0,this.isDone=!1,this.callbackAttached=!1,t((e=>{this.isDone=!0,this.result=e,this.nextCallback&&this.nextCallback(e)}),(e=>{this.isDone=!0,this.error=e,this.catchCallback&&this.catchCallback(e)}))}catch(t){return this.next(void 0,t)}next(t,e){return this.callbackAttached&&O(59440),this.callbackAttached=!0,this.isDone?this.error?this.wrapFailure(e,this.error):this.wrapSuccess(t,this.result):new A(((n,s)=>{this.nextCallback=i=>{this.wrapSuccess(t,i).next(n,s)},this.catchCallback=i=>{this.wrapFailure(e,i).next(n,s)}}))}toPromise(){return new Promise(((t,e)=>{this.next(t,e)}))}wrapUserFunction(t){try{const e=t();return e instanceof A?e:A.resolve(e)}catch(e){return A.reject(e)}}wrapSuccess(t,e){return t?this.wrapUserFunction((()=>t(e))):A.resolve(e)}wrapFailure(t,e){return t?this.wrapUserFunction((()=>t(e))):A.reject(e)}static resolve(t){return new A(((e,n)=>{e(t)}))}static reject(t){return new A(((e,n)=>{n(t)}))}static waitFor(t){return new A(((e,n)=>{let s=0,i=0,a=!1;t.forEach((u=>{++s,u.next((()=>{++i,a&&i===s&&e()}),(c=>n(c)))})),a=!0,i===s&&e()}))}static or(t){let e=A.resolve(!1);for(const n of t)e=e.next((s=>s?A.resolve(s):n()));return e}static forEach(t,e){const n=[];return t.forEach(((s,i)=>{n.push(e.call(this,s,i))})),this.waitFor(n)}static mapArray(t,e){return new A(((n,s)=>{const i=t.length,a=new Array(i);let u=0;for(let c=0;c<i;c++){const h=c;e(t[h]).next((f=>{a[h]=f,++u,u===i&&n(a)}),(f=>s(f)))}}))}static doWhile(t,e){return new A(((n,s)=>{const i=()=>{t()===!0?e().next((()=>{i()}),s):n()};i()}))}}/**
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
 */const Bt="SimpleDb";class Ei{static open(t,e,n,s){try{return new Ei(e,t.transaction(s,n))}catch(i){throw new Ur(e,i)}}constructor(t,e){this.action=t,this.transaction=e,this.aborted=!1,this.S=new Rt,this.transaction.oncomplete=()=>{this.S.resolve()},this.transaction.onabort=()=>{e.error?this.S.reject(new Ur(t,e.error)):this.S.resolve()},this.transaction.onerror=n=>{const s=sa(n.target.error);this.S.reject(new Ur(t,s))}}get D(){return this.S.promise}abort(t){t&&this.S.reject(t),this.aborted||(x(Bt,"Aborting transaction:",t?t.message:"Client-initiated abort"),this.aborted=!0,this.transaction.abort())}C(){const t=this.transaction;this.aborted||typeof t.commit!="function"||t.commit()}store(t){const e=this.transaction.objectStore(t);return new km(e)}}class te{static delete(t){return x(Bt,"Removing database:",t),Xe(fm().indexedDB.deleteDatabase(t)).toPromise()}static v(){if(!mm())return!1;if(te.F())return!0;const t=si(),e=te.M(t),n=0<e&&e<10,s=eh(t),i=0<s&&s<4.5;return!(t.indexOf("MSIE ")>0||t.indexOf("Trident/")>0||t.indexOf("Edge/")>0||n||i)}static F(){var t;return typeof process<"u"&&((t=process.__PRIVATE_env)==null?void 0:t.__PRIVATE_USE_MOCK_PERSISTENCE)==="YES"}static O(t,e){return t.store(e)}static M(t){const e=t.match(/i(?:phone|pad|pod) os ([\d_]+)/i),n=e?e[1].split("_").slice(0,2).join("."):"-1";return Number(n)}constructor(t,e,n){this.name=t,this.version=e,this.N=n,this.B=null,te.M(si())===12.2&&mt("Firestore persistence suffers from a bug in iOS 12.2 Safari that may cause your app to stop working. See https://stackoverflow.com/q/56496296/110915 for details and a potential workaround.")}async L(t){return this.db||(x(Bt,"Opening database:",this.name),this.db=await new Promise(((e,n)=>{const s=indexedDB.open(this.name,this.version);s.onsuccess=i=>{const a=i.target.result;e(a)},s.onblocked=()=>{n(new Ur(t,"Cannot upgrade IndexedDB schema while another tab is open. Close all tabs that access Firestore and reload this page to proceed."))},s.onerror=i=>{const a=i.target.error;a.name==="VersionError"?n(new b(P.FAILED_PRECONDITION,"A newer version of the Firestore SDK was previously used and so the persisted data is not compatible with the version of the SDK you are now using. The SDK will operate with persistence disabled. If you need persistence, please re-upgrade to a newer version of the SDK or else clear the persisted IndexedDB data for your app to start fresh.")):a.name==="InvalidStateError"?n(new b(P.FAILED_PRECONDITION,"Unable to open an IndexedDB connection. This could be due to running in a private browsing session on a browser whose private browsing sessions do not support IndexedDB: "+a)):n(new Ur(t,a))},s.onupgradeneeded=i=>{x(Bt,'Database "'+this.name+'" requires upgrade from version:',i.oldVersion);const a=i.target.result;this.N.k(a,s.transaction,i.oldVersion,this.version).next((()=>{x(Bt,"Database upgrade to version "+this.version+" complete")}))}}))),this.K&&(this.db.onversionchange=e=>this.K(e)),this.db}q(t){this.K=t,this.db&&(this.db.onversionchange=e=>t(e))}async runTransaction(t,e,n,s){const i=e==="readonly";let a=0;for(;;){++a;try{this.db=await this.L(t);const u=Ei.open(this.db,t,i?"readonly":"readwrite",n),c=s(u).next((h=>(u.C(),h))).catch((h=>(u.abort(h),A.reject(h)))).toPromise();return c.catch((()=>{})),await u.D,c}catch(u){const c=u,h=c.name!=="FirebaseError"&&a<3;if(x(Bt,"Transaction failed with error:",c.message,"Retrying:",h),this.close(),!h)return Promise.reject(c)}}}close(){this.db&&this.db.close(),this.db=void 0}}function eh(r){const t=r.match(/Android ([\d.]+)/i),e=t?t[1].split(".").slice(0,2).join("."):"-1";return Number(e)}class Nm{constructor(t){this.U=t,this.$=!1,this.W=null}get isDone(){return this.$}get G(){return this.W}set cursor(t){this.U=t}done(){this.$=!0}j(t){this.W=t}delete(){return Xe(this.U.delete())}}class Ur extends b{constructor(t,e){super(P.UNAVAILABLE,`IndexedDB transaction '${t}' failed: ${e}`),this.name="IndexedDbTransactionError"}}function Le(r){return r.name==="IndexedDbTransactionError"}class km{constructor(t){this.store=t}put(t,e){let n;return e!==void 0?(x(Bt,"PUT",this.store.name,t,e),n=this.store.put(e,t)):(x(Bt,"PUT",this.store.name,"<auto-key>",t),n=this.store.put(t)),Xe(n)}add(t){return x(Bt,"ADD",this.store.name,t,t),Xe(this.store.add(t))}get(t){return Xe(this.store.get(t)).next((e=>(e===void 0&&(e=null),x(Bt,"GET",this.store.name,t,e),e)))}delete(t){return x(Bt,"DELETE",this.store.name,t),Xe(this.store.delete(t))}count(){return x(Bt,"COUNT",this.store.name),Xe(this.store.count())}H(t,e){const n=this.options(t,e),s=n.index?this.store.index(n.index):this.store;if(typeof s.getAll=="function"){const i=s.getAll(n.range);return new A(((a,u)=>{i.onerror=c=>{u(c.target.error)},i.onsuccess=c=>{a(c.target.result)}}))}{const i=this.cursor(n),a=[];return this.J(i,((u,c)=>{a.push(c)})).next((()=>a))}}Z(t,e){const n=this.store.getAll(t,e===null?void 0:e);return new A(((s,i)=>{n.onerror=a=>{i(a.target.error)},n.onsuccess=a=>{s(a.target.result)}}))}X(t,e){x(Bt,"DELETE ALL",this.store.name);const n=this.options(t,e);n.Y=!1;const s=this.cursor(n);return this.J(s,((i,a,u)=>u.delete()))}ee(t,e){let n;e?n=t:(n={},e=t);const s=this.cursor(n);return this.J(s,e)}te(t){const e=this.cursor({});return new A(((n,s)=>{e.onerror=i=>{const a=sa(i.target.error);s(a)},e.onsuccess=i=>{const a=i.target.result;a?t(a.primaryKey,a.value).next((u=>{u?a.continue():n()})):n()}}))}J(t,e){const n=[];return new A(((s,i)=>{t.onerror=a=>{i(a.target.error)},t.onsuccess=a=>{const u=a.target.result;if(!u)return void s();const c=new Nm(u),h=e(u.primaryKey,u.value,c);if(h instanceof A){const f=h.catch((m=>(c.done(),A.reject(m))));n.push(f)}c.isDone?s():c.G===null?u.continue():u.continue(c.G)}})).next((()=>A.waitFor(n)))}options(t,e){let n;return t!==void 0&&(typeof t=="string"?n=t:e=t),{index:n,range:e}}cursor(t){let e="next";if(t.reverse&&(e="prev"),t.index){const n=this.store.index(t.index);return t.Y?n.openKeyCursor(t.range,e):n.openCursor(t.range,e)}return this.store.openCursor(t.range,e)}}function Xe(r){return new A(((t,e)=>{r.onsuccess=n=>{const s=n.target.result;t(s)},r.onerror=n=>{const s=sa(n.target.error);e(s)}}))}let gc=!1;function sa(r){const t=te.M(si());if(t>=12.2&&t<13){const e="An internal error was encountered in the Indexed Database server";if(r.message.indexOf(e)>=0){const n=new b("internal",`IOS_INDEXEDDB_BUG1: IndexedDb has thrown '${e}'. This is likely due to an unavoidable bug in iOS. See https://stackoverflow.com/q/56496296/110915 for details and a potential workaround.`);return gc||(gc=!0,setTimeout((()=>{throw n}),0)),n}}return r}const jr="IndexBackfiller";class Fm{constructor(t,e){this.asyncQueue=t,this.ne=e,this.task=null}start(){this.re(15e3)}stop(){this.task&&(this.task.cancel(),this.task=null)}get started(){return this.task!==null}re(t){x(jr,`Scheduled in ${t}ms`),this.task=this.asyncQueue.enqueueAfterDelay("index_backfill",t,(async()=>{this.task=null;try{const e=await this.ne.ie();x(jr,`Documents written: ${e}`)}catch(e){Le(e)?x(jr,"Ignoring IndexedDB error during index backfill: ",e):await Oe(e)}await this.re(6e4)}))}}class Mm{constructor(t,e){this.localStore=t,this.persistence=e}async ie(t=50){return this.persistence.runTransaction("Backfill Indexes","readwrite-primary",(e=>this.se(e,t)))}se(t,e){const n=new Set;let s=e,i=!0;return A.doWhile((()=>i===!0&&s>0),(()=>this.localStore.indexManager.getNextCollectionGroupToUpdate(t).next((a=>{if(a!==null&&!n.has(a))return x(jr,`Processing collection: ${a}`),this.oe(t,a,s).next((u=>{s-=u,n.add(a)}));i=!1})))).next((()=>e-s))}oe(t,e,n){return this.localStore.indexManager.getMinOffsetFromCollectionGroup(t,e).next((s=>this.localStore.localDocuments.getNextDocuments(t,e,s,n).next((i=>{const a=i.changes;return this.localStore.indexManager.updateIndexEntries(t,a).next((()=>this._e(s,i))).next((u=>(x(jr,`Updating offset: ${u}`),this.localStore.indexManager.updateCollectionGroup(t,e,u)))).next((()=>a.size))}))))}_e(t,e){let n=t;return e.changes.forEach(((s,i)=>{const a=Xl(i);ra(a,n)>0&&(n=a)})),new Kt(n.readTime,n.documentKey,Math.max(e.batchId,t.largestBatchId))}}/**
 * @license
 * Copyright 2018 Google LLC
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
 */class Mt{constructor(t,e){this.previousValue=t,e&&(e.sequenceNumberHandler=n=>this.ae(n),this.ue=n=>e.writeSequenceNumber(n))}ae(t){return this.previousValue=Math.max(t,this.previousValue),this.previousValue}next(){const t=++this.previousValue;return this.ue&&this.ue(t),t}}Mt.ce=-1;/**
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
 */const be=-1;function ls(r){return r==null}function Jr(r){return r===0&&1/r==-1/0}function nh(r){return typeof r=="number"&&Number.isInteger(r)&&!Jr(r)&&r<=Number.MAX_SAFE_INTEGER&&r>=Number.MIN_SAFE_INTEGER}/**
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
 */const ii="";function xt(r){let t="";for(let e=0;e<r.length;e++)t.length>0&&(t=pc(t)),t=Om(r.get(e),t);return pc(t)}function Om(r,t){let e=t;const n=r.length;for(let s=0;s<n;s++){const i=r.charAt(s);switch(i){case"\0":e+="";break;case ii:e+="";break;default:e+=i}}return e}function pc(r){return r+ii+""}function Xt(r){const t=r.length;if(L(t>=2,64408,{path:r}),t===2)return L(r.charAt(0)===ii&&r.charAt(1)==="",56145,{path:r}),$.emptyPath();const e=t-2,n=[];let s="";for(let i=0;i<t;){const a=r.indexOf(ii,i);switch((a<0||a>e)&&O(50515,{path:r}),r.charAt(a+1)){case"":const u=r.substring(i,a);let c;s.length===0?c=u:(s+=u,c=s,s=""),n.push(c);break;case"":s+=r.substring(i,a),s+="\0";break;case"":s+=r.substring(i,a+1);break;default:O(61167,{path:r})}i=a+2}return new $(n)}/**
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
 */const Ye="remoteDocuments",hs="owner",Rn="owner",Yr="mutationQueues",Lm="userId",Qt="mutations",_c="batchId",nn="userMutationsIndex",yc=["userId","batchId"];/**
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
 */function Ws(r,t){return[r,xt(t)]}function rh(r,t,e){return[r,xt(t),e]}const qm={},jn="documentMutations",oi="remoteDocumentsV14",Bm=["prefixPath","collectionGroup","readTime","documentId"],Hs="documentKeyIndex",Um=["prefixPath","collectionGroup","documentId"],sh="collectionGroupIndex",jm=["collectionGroup","readTime","prefixPath","documentId"],Xr="remoteDocumentGlobal",xo="remoteDocumentGlobalKey",zn="targets",ih="queryTargetsIndex",zm=["canonicalId","targetId"],Gn="targetDocuments",Gm=["targetId","path"],ia="documentTargetsIndex",Km=["path","targetId"],ai="targetGlobalKey",sn="targetGlobal",Zr="collectionParents",$m=["collectionId","parent"],Kn="clientMetadata",Qm="clientId",wi="bundles",Wm="bundleId",Ai="namedQueries",Hm="name",oa="indexConfiguration",Jm="indexId",Do="collectionGroupIndex",Ym="collectionGroup",zr="indexState",Xm=["indexId","uid"],oh="sequenceNumberIndex",Zm=["uid","sequenceNumber"],Gr="indexEntries",tg=["indexId","uid","arrayValue","directionalValue","orderedDocumentKey","documentKey"],ah="documentKeyIndex",eg=["indexId","uid","orderedDocumentKey"],vi="documentOverlays",ng=["userId","collectionPath","documentId"],No="collectionPathOverlayIndex",rg=["userId","collectionPath","largestBatchId"],uh="collectionGroupOverlayIndex",sg=["userId","collectionGroup","largestBatchId"],aa="globals",ig="name",ch=[Yr,Qt,jn,Ye,zn,hs,sn,Gn,Kn,Xr,Zr,wi,Ai],og=[...ch,vi],lh=[Yr,Qt,jn,oi,zn,hs,sn,Gn,Kn,Xr,Zr,wi,Ai,vi],hh=lh,ua=[...hh,oa,zr,Gr],ag=ua,dh=[...ua,aa],ug=dh;/**
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
 */class ko extends th{constructor(t,e){super(),this.le=t,this.currentSequenceNumber=e}}function Tt(r,t){const e=F(r);return te.O(e.le,t)}/**
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
 */function Ic(r){let t=0;for(const e in r)Object.prototype.hasOwnProperty.call(r,e)&&t++;return t}function qe(r,t){for(const e in r)Object.prototype.hasOwnProperty.call(r,e)&&t(e,r[e])}function fh(r,t){const e=[];for(const n in r)Object.prototype.hasOwnProperty.call(r,n)&&e.push(t(r[n],n,r));return e}function mh(r){for(const t in r)if(Object.prototype.hasOwnProperty.call(r,t))return!1;return!0}/**
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
 */class it{constructor(t,e){this.comparator=t,this.root=e||St.EMPTY}insert(t,e){return new it(this.comparator,this.root.insert(t,e,this.comparator).copy(null,null,St.BLACK,null,null))}remove(t){return new it(this.comparator,this.root.remove(t,this.comparator).copy(null,null,St.BLACK,null,null))}get(t){let e=this.root;for(;!e.isEmpty();){const n=this.comparator(t,e.key);if(n===0)return e.value;n<0?e=e.left:n>0&&(e=e.right)}return null}indexOf(t){let e=0,n=this.root;for(;!n.isEmpty();){const s=this.comparator(t,n.key);if(s===0)return e+n.left.size;s<0?n=n.left:(e+=n.left.size+1,n=n.right)}return-1}isEmpty(){return this.root.isEmpty()}get size(){return this.root.size}minKey(){return this.root.minKey()}maxKey(){return this.root.maxKey()}inorderTraversal(t){return this.root.inorderTraversal(t)}forEach(t){this.inorderTraversal(((e,n)=>(t(e,n),!1)))}toString(){const t=[];return this.inorderTraversal(((e,n)=>(t.push(`${e}:${n}`),!1))),`{${t.join(", ")}}`}reverseTraversal(t){return this.root.reverseTraversal(t)}getIterator(){return new Bs(this.root,null,this.comparator,!1)}getIteratorFrom(t){return new Bs(this.root,t,this.comparator,!1)}getReverseIterator(){return new Bs(this.root,null,this.comparator,!0)}getReverseIteratorFrom(t){return new Bs(this.root,t,this.comparator,!0)}}class Bs{constructor(t,e,n,s){this.isReverse=s,this.nodeStack=[];let i=1;for(;!t.isEmpty();)if(i=e?n(t.key,e):1,e&&s&&(i*=-1),i<0)t=this.isReverse?t.left:t.right;else{if(i===0){this.nodeStack.push(t);break}this.nodeStack.push(t),t=this.isReverse?t.right:t.left}}getNext(){let t=this.nodeStack.pop();const e={key:t.key,value:t.value};if(this.isReverse)for(t=t.left;!t.isEmpty();)this.nodeStack.push(t),t=t.right;else for(t=t.right;!t.isEmpty();)this.nodeStack.push(t),t=t.left;return e}hasNext(){return this.nodeStack.length>0}peek(){if(this.nodeStack.length===0)return null;const t=this.nodeStack[this.nodeStack.length-1];return{key:t.key,value:t.value}}}class St{constructor(t,e,n,s,i){this.key=t,this.value=e,this.color=n??St.RED,this.left=s??St.EMPTY,this.right=i??St.EMPTY,this.size=this.left.size+1+this.right.size}copy(t,e,n,s,i){return new St(t??this.key,e??this.value,n??this.color,s??this.left,i??this.right)}isEmpty(){return!1}inorderTraversal(t){return this.left.inorderTraversal(t)||t(this.key,this.value)||this.right.inorderTraversal(t)}reverseTraversal(t){return this.right.reverseTraversal(t)||t(this.key,this.value)||this.left.reverseTraversal(t)}min(){return this.left.isEmpty()?this:this.left.min()}minKey(){return this.min().key}maxKey(){return this.right.isEmpty()?this.key:this.right.maxKey()}insert(t,e,n){let s=this;const i=n(t,s.key);return s=i<0?s.copy(null,null,null,s.left.insert(t,e,n),null):i===0?s.copy(null,e,null,null,null):s.copy(null,null,null,null,s.right.insert(t,e,n)),s.fixUp()}removeMin(){if(this.left.isEmpty())return St.EMPTY;let t=this;return t.left.isRed()||t.left.left.isRed()||(t=t.moveRedLeft()),t=t.copy(null,null,null,t.left.removeMin(),null),t.fixUp()}remove(t,e){let n,s=this;if(e(t,s.key)<0)s.left.isEmpty()||s.left.isRed()||s.left.left.isRed()||(s=s.moveRedLeft()),s=s.copy(null,null,null,s.left.remove(t,e),null);else{if(s.left.isRed()&&(s=s.rotateRight()),s.right.isEmpty()||s.right.isRed()||s.right.left.isRed()||(s=s.moveRedRight()),e(t,s.key)===0){if(s.right.isEmpty())return St.EMPTY;n=s.right.min(),s=s.copy(n.key,n.value,null,null,s.right.removeMin())}s=s.copy(null,null,null,null,s.right.remove(t,e))}return s.fixUp()}isRed(){return this.color}fixUp(){let t=this;return t.right.isRed()&&!t.left.isRed()&&(t=t.rotateLeft()),t.left.isRed()&&t.left.left.isRed()&&(t=t.rotateRight()),t.left.isRed()&&t.right.isRed()&&(t=t.colorFlip()),t}moveRedLeft(){let t=this.colorFlip();return t.right.left.isRed()&&(t=t.copy(null,null,null,null,t.right.rotateRight()),t=t.rotateLeft(),t=t.colorFlip()),t}moveRedRight(){let t=this.colorFlip();return t.left.left.isRed()&&(t=t.rotateRight(),t=t.colorFlip()),t}rotateLeft(){const t=this.copy(null,null,St.RED,null,this.right.left);return this.right.copy(null,null,this.color,t,null)}rotateRight(){const t=this.copy(null,null,St.RED,this.left.right,null);return this.left.copy(null,null,this.color,null,t)}colorFlip(){const t=this.left.copy(null,null,!this.left.color,null,null),e=this.right.copy(null,null,!this.right.color,null,null);return this.copy(null,null,!this.color,t,e)}checkMaxDepth(){const t=this.check();return Math.pow(2,t)<=this.size+1}check(){if(this.isRed()&&this.left.isRed())throw O(43730,{key:this.key,value:this.value});if(this.right.isRed())throw O(14113,{key:this.key,value:this.value});const t=this.left.check();if(t!==this.right.check())throw O(27949);return t+(this.isRed()?0:1)}}St.EMPTY=null,St.RED=!0,St.BLACK=!1;St.EMPTY=new class{constructor(){this.size=0}get key(){throw O(57766)}get value(){throw O(16141)}get color(){throw O(16727)}get left(){throw O(29726)}get right(){throw O(36894)}copy(t,e,n,s,i){return this}insert(t,e,n){return new St(t,e)}remove(t,e){return this}isEmpty(){return!0}inorderTraversal(t){return!1}reverseTraversal(t){return!1}minKey(){return null}maxKey(){return null}isRed(){return!1}checkMaxDepth(){return!0}check(){return 0}};/**
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
 */class et{constructor(t){this.comparator=t,this.data=new it(this.comparator)}has(t){return this.data.get(t)!==null}first(){return this.data.minKey()}last(){return this.data.maxKey()}get size(){return this.data.size}indexOf(t){return this.data.indexOf(t)}forEach(t){this.data.inorderTraversal(((e,n)=>(t(e),!1)))}forEachInRange(t,e){const n=this.data.getIteratorFrom(t[0]);for(;n.hasNext();){const s=n.getNext();if(this.comparator(s.key,t[1])>=0)return;e(s.key)}}forEachWhile(t,e){let n;for(n=e!==void 0?this.data.getIteratorFrom(e):this.data.getIterator();n.hasNext();)if(!t(n.getNext().key))return}firstAfterOrEqual(t){const e=this.data.getIteratorFrom(t);return e.hasNext()?e.getNext().key:null}getIterator(){return new Tc(this.data.getIterator())}getIteratorFrom(t){return new Tc(this.data.getIteratorFrom(t))}add(t){return this.copy(this.data.remove(t).insert(t,!0))}delete(t){return this.has(t)?this.copy(this.data.remove(t)):this}isEmpty(){return this.data.isEmpty()}unionWith(t){let e=this;return e.size<t.size&&(e=t,t=this),t.forEach((n=>{e=e.add(n)})),e}isEqual(t){if(!(t instanceof et)||this.size!==t.size)return!1;const e=this.data.getIterator(),n=t.data.getIterator();for(;e.hasNext();){const s=e.getNext().key,i=n.getNext().key;if(this.comparator(s,i)!==0)return!1}return!0}toArray(){const t=[];return this.forEach((e=>{t.push(e)})),t}toString(){const t=[];return this.forEach((e=>t.push(e))),"SortedSet("+t.toString()+")"}copy(t){const e=new et(this.comparator);return e.data=t,e}}class Tc{constructor(t){this.iter=t}getNext(){return this.iter.getNext().key}hasNext(){return this.iter.hasNext()}}function Pn(r){return r.hasNext()?r.getNext():void 0}/**
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
 */class Ot{constructor(t){this.fields=t,t.sort(ct.comparator)}static empty(){return new Ot([])}unionWith(t){let e=new et(ct.comparator);for(const n of this.fields)e=e.add(n);for(const n of t)e=e.add(n);return new Ot(e.toArray())}covers(t){for(const e of this.fields)if(e.isPrefixOf(t))return!0;return!1}isEqual(t){return Ln(this.fields,t.fields,((e,n)=>e.isEqual(n)))}}/**
 * @license
 * Copyright 2023 Google LLC
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
 */class gh extends Error{constructor(){super(...arguments),this.name="Base64DecodeError"}}/**
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
 */function Py(){return typeof atob<"u"}/**
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
 */class ft{constructor(t){this.binaryString=t}static fromBase64String(t){const e=(function(s){try{return atob(s)}catch(i){throw typeof DOMException<"u"&&i instanceof DOMException?new gh("Invalid base64 string: "+i):i}})(t);return new ft(e)}static fromUint8Array(t){const e=(function(s){let i="";for(let a=0;a<s.length;++a)i+=String.fromCharCode(s[a]);return i})(t);return new ft(e)}[Symbol.iterator](){let t=0;return{next:()=>t<this.binaryString.length?{value:this.binaryString.charCodeAt(t++),done:!1}:{value:void 0,done:!0}}}toBase64(){return(function(e){return btoa(e)})(this.binaryString)}toUint8Array(){return(function(e){const n=new Uint8Array(e.length);for(let s=0;s<e.length;s++)n[s]=e.charCodeAt(s);return n})(this.binaryString)}approximateByteSize(){return 2*this.binaryString.length}compareTo(t){return z(this.binaryString,t.binaryString)}isEqual(t){return this.binaryString===t.binaryString}}ft.EMPTY_BYTE_STRING=new ft("");const cg=new RegExp(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d+))?Z$/);function ae(r){if(L(!!r,39018),typeof r=="string"){let t=0;const e=cg.exec(r);if(L(!!e,46558,{timestamp:r}),e[1]){let s=e[1];s=(s+"000000000").substr(0,9),t=Number(s)}const n=new Date(r);return{seconds:Math.floor(n.getTime()/1e3),nanos:t}}return{seconds:ut(r.seconds),nanos:ut(r.nanos)}}function ut(r){return typeof r=="number"?r:typeof r=="string"?Number(r):0}function ue(r){return typeof r=="string"?ft.fromBase64String(r):ft.fromUint8Array(r)}/**
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
 */const ph="server_timestamp",_h="__type__",yh="__previous_value__",Ih="__local_write_time__";function Ri(r){var e,n;return((n=(((e=r==null?void 0:r.mapValue)==null?void 0:e.fields)||{})[_h])==null?void 0:n.stringValue)===ph}function Pi(r){const t=r.mapValue.fields[yh];return Ri(t)?Pi(t):t}function ts(r){const t=ae(r.mapValue.fields[Ih].timestampValue);return new Z(t.seconds,t.nanos)}/**
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
 */class lg{constructor(t,e,n,s,i,a,u,c,h,f,m){this.databaseId=t,this.appId=e,this.persistenceKey=n,this.host=s,this.ssl=i,this.forceLongPolling=a,this.autoDetectLongPolling=u,this.longPollingOptions=c,this.useFetchStreams=h,this.isUsingEmulator=f,this.apiKey=m}}const es="(default)";class an{constructor(t,e){this.projectId=t,this.database=e||es}static empty(){return new an("","")}get isDefaultDatabase(){return this.database===es}isEqual(t){return t instanceof an&&t.projectId===this.projectId&&t.database===this.database}}function hg(r,t){if(!Object.prototype.hasOwnProperty.apply(r.options,["projectId"]))throw new b(P.INVALID_ARGUMENT,'"projectId" not provided in firebase.initializeApp.');return new an(r.options.projectId,t)}/**
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
 */const ca="__type__",Th="__max__",Re={mapValue:{fields:{__type__:{stringValue:Th}}}},la="__vector__",$n="value",Js={nullValue:"NULL_VALUE"};function xe(r){return"nullValue"in r?0:"booleanValue"in r?1:"integerValue"in r||"doubleValue"in r?2:"timestampValue"in r?3:"stringValue"in r?5:"bytesValue"in r?6:"referenceValue"in r?7:"geoPointValue"in r?8:"arrayValue"in r?9:"mapValue"in r?Ri(r)?4:Eh(r)?9007199254740991:Si(r)?10:11:O(28295,{value:r})}function se(r,t){if(r===t)return!0;const e=xe(r);if(e!==xe(t))return!1;switch(e){case 0:case 9007199254740991:return!0;case 1:return r.booleanValue===t.booleanValue;case 4:return ts(r).isEqual(ts(t));case 3:return(function(s,i){if(typeof s.timestampValue=="string"&&typeof i.timestampValue=="string"&&s.timestampValue.length===i.timestampValue.length)return s.timestampValue===i.timestampValue;const a=ae(s.timestampValue),u=ae(i.timestampValue);return a.seconds===u.seconds&&a.nanos===u.nanos})(r,t);case 5:return r.stringValue===t.stringValue;case 6:return(function(s,i){return ue(s.bytesValue).isEqual(ue(i.bytesValue))})(r,t);case 7:return r.referenceValue===t.referenceValue;case 8:return(function(s,i){return ut(s.geoPointValue.latitude)===ut(i.geoPointValue.latitude)&&ut(s.geoPointValue.longitude)===ut(i.geoPointValue.longitude)})(r,t);case 2:return(function(s,i){if("integerValue"in s&&"integerValue"in i)return ut(s.integerValue)===ut(i.integerValue);if("doubleValue"in s&&"doubleValue"in i){const a=ut(s.doubleValue),u=ut(i.doubleValue);return a===u?Jr(a)===Jr(u):isNaN(a)&&isNaN(u)}return!1})(r,t);case 9:return Ln(r.arrayValue.values||[],t.arrayValue.values||[],se);case 10:case 11:return(function(s,i){const a=s.mapValue.fields||{},u=i.mapValue.fields||{};if(Ic(a)!==Ic(u))return!1;for(const c in a)if(a.hasOwnProperty(c)&&(u[c]===void 0||!se(a[c],u[c])))return!1;return!0})(r,t);default:return O(52216,{left:r})}}function ns(r,t){return(r.values||[]).find((e=>se(e,t)))!==void 0}function De(r,t){if(r===t)return 0;const e=xe(r),n=xe(t);if(e!==n)return z(e,n);switch(e){case 0:case 9007199254740991:return 0;case 1:return z(r.booleanValue,t.booleanValue);case 2:return(function(i,a){const u=ut(i.integerValue||i.doubleValue),c=ut(a.integerValue||a.doubleValue);return u<c?-1:u>c?1:u===c?0:isNaN(u)?isNaN(c)?0:-1:1})(r,t);case 3:return Ec(r.timestampValue,t.timestampValue);case 4:return Ec(ts(r),ts(t));case 5:return Vo(r.stringValue,t.stringValue);case 6:return(function(i,a){const u=ue(i),c=ue(a);return u.compareTo(c)})(r.bytesValue,t.bytesValue);case 7:return(function(i,a){const u=i.split("/"),c=a.split("/");for(let h=0;h<u.length&&h<c.length;h++){const f=z(u[h],c[h]);if(f!==0)return f}return z(u.length,c.length)})(r.referenceValue,t.referenceValue);case 8:return(function(i,a){const u=z(ut(i.latitude),ut(a.latitude));return u!==0?u:z(ut(i.longitude),ut(a.longitude))})(r.geoPointValue,t.geoPointValue);case 9:return wc(r.arrayValue,t.arrayValue);case 10:return(function(i,a){var p,v,C,N;const u=i.fields||{},c=a.fields||{},h=(p=u[$n])==null?void 0:p.arrayValue,f=(v=c[$n])==null?void 0:v.arrayValue,m=z(((C=h==null?void 0:h.values)==null?void 0:C.length)||0,((N=f==null?void 0:f.values)==null?void 0:N.length)||0);return m!==0?m:wc(h,f)})(r.mapValue,t.mapValue);case 11:return(function(i,a){if(i===Re.mapValue&&a===Re.mapValue)return 0;if(i===Re.mapValue)return 1;if(a===Re.mapValue)return-1;const u=i.fields||{},c=Object.keys(u),h=a.fields||{},f=Object.keys(h);c.sort(),f.sort();for(let m=0;m<c.length&&m<f.length;++m){const p=Vo(c[m],f[m]);if(p!==0)return p;const v=De(u[c[m]],h[f[m]]);if(v!==0)return v}return z(c.length,f.length)})(r.mapValue,t.mapValue);default:throw O(23264,{he:e})}}function Ec(r,t){if(typeof r=="string"&&typeof t=="string"&&r.length===t.length)return z(r,t);const e=ae(r),n=ae(t),s=z(e.seconds,n.seconds);return s!==0?s:z(e.nanos,n.nanos)}function wc(r,t){const e=r.values||[],n=t.values||[];for(let s=0;s<e.length&&s<n.length;++s){const i=De(e[s],n[s]);if(i)return i}return z(e.length,n.length)}function Qn(r){return Fo(r)}function Fo(r){return"nullValue"in r?"null":"booleanValue"in r?""+r.booleanValue:"integerValue"in r?""+r.integerValue:"doubleValue"in r?""+r.doubleValue:"timestampValue"in r?(function(e){const n=ae(e);return`time(${n.seconds},${n.nanos})`})(r.timestampValue):"stringValue"in r?r.stringValue:"bytesValue"in r?(function(e){return ue(e).toBase64()})(r.bytesValue):"referenceValue"in r?(function(e){return k.fromName(e).toString()})(r.referenceValue):"geoPointValue"in r?(function(e){return`geo(${e.latitude},${e.longitude})`})(r.geoPointValue):"arrayValue"in r?(function(e){let n="[",s=!0;for(const i of e.values||[])s?s=!1:n+=",",n+=Fo(i);return n+"]"})(r.arrayValue):"mapValue"in r?(function(e){const n=Object.keys(e.fields||{}).sort();let s="{",i=!0;for(const a of n)i?i=!1:s+=",",s+=`${a}:${Fo(e.fields[a])}`;return s+"}"})(r.mapValue):O(61005,{value:r})}function Ys(r){switch(xe(r)){case 0:case 1:return 4;case 2:return 8;case 3:case 8:return 16;case 4:const t=Pi(r);return t?16+Ys(t):16;case 5:return 2*r.stringValue.length;case 6:return ue(r.bytesValue).approximateByteSize();case 7:return r.referenceValue.length;case 9:return(function(n){return(n.values||[]).reduce(((s,i)=>s+Ys(i)),0)})(r.arrayValue);case 10:case 11:return(function(n){let s=0;return qe(n.fields,((i,a)=>{s+=i.length+Ys(a)})),s})(r.mapValue);default:throw O(13486,{value:r})}}function un(r,t){return{referenceValue:`projects/${r.projectId}/databases/${r.database}/documents/${t.path.canonicalString()}`}}function Mo(r){return!!r&&"integerValue"in r}function rs(r){return!!r&&"arrayValue"in r}function Ac(r){return!!r&&"nullValue"in r}function vc(r){return!!r&&"doubleValue"in r&&isNaN(Number(r.doubleValue))}function Xs(r){return!!r&&"mapValue"in r}function Si(r){var e,n;return((n=(((e=r==null?void 0:r.mapValue)==null?void 0:e.fields)||{})[ca])==null?void 0:n.stringValue)===la}function Kr(r){if(r.geoPointValue)return{geoPointValue:{...r.geoPointValue}};if(r.timestampValue&&typeof r.timestampValue=="object")return{timestampValue:{...r.timestampValue}};if(r.mapValue){const t={mapValue:{fields:{}}};return qe(r.mapValue.fields,((e,n)=>t.mapValue.fields[e]=Kr(n))),t}if(r.arrayValue){const t={arrayValue:{values:[]}};for(let e=0;e<(r.arrayValue.values||[]).length;++e)t.arrayValue.values[e]=Kr(r.arrayValue.values[e]);return t}return{...r}}function Eh(r){return(((r.mapValue||{}).fields||{}).__type__||{}).stringValue===Th}const wh={mapValue:{fields:{[ca]:{stringValue:la},[$n]:{arrayValue:{}}}}};function dg(r){return"nullValue"in r?Js:"booleanValue"in r?{booleanValue:!1}:"integerValue"in r||"doubleValue"in r?{doubleValue:NaN}:"timestampValue"in r?{timestampValue:{seconds:Number.MIN_SAFE_INTEGER}}:"stringValue"in r?{stringValue:""}:"bytesValue"in r?{bytesValue:""}:"referenceValue"in r?un(an.empty(),k.empty()):"geoPointValue"in r?{geoPointValue:{latitude:-90,longitude:-180}}:"arrayValue"in r?{arrayValue:{}}:"mapValue"in r?Si(r)?wh:{mapValue:{}}:O(35942,{value:r})}function fg(r){return"nullValue"in r?{booleanValue:!1}:"booleanValue"in r?{doubleValue:NaN}:"integerValue"in r||"doubleValue"in r?{timestampValue:{seconds:Number.MIN_SAFE_INTEGER}}:"timestampValue"in r?{stringValue:""}:"stringValue"in r?{bytesValue:""}:"bytesValue"in r?un(an.empty(),k.empty()):"referenceValue"in r?{geoPointValue:{latitude:-90,longitude:-180}}:"geoPointValue"in r?{arrayValue:{}}:"arrayValue"in r?wh:"mapValue"in r?Si(r)?{mapValue:{}}:Re:O(61959,{value:r})}function Rc(r,t){const e=De(r.value,t.value);return e!==0?e:r.inclusive&&!t.inclusive?-1:!r.inclusive&&t.inclusive?1:0}function Pc(r,t){const e=De(r.value,t.value);return e!==0?e:r.inclusive&&!t.inclusive?1:!r.inclusive&&t.inclusive?-1:0}/**
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
 */class vt{constructor(t){this.value=t}static empty(){return new vt({mapValue:{}})}field(t){if(t.isEmpty())return this.value;{let e=this.value;for(let n=0;n<t.length-1;++n)if(e=(e.mapValue.fields||{})[t.get(n)],!Xs(e))return null;return e=(e.mapValue.fields||{})[t.lastSegment()],e||null}}set(t,e){this.getFieldsMap(t.popLast())[t.lastSegment()]=Kr(e)}setAll(t){let e=ct.emptyPath(),n={},s=[];t.forEach(((a,u)=>{if(!e.isImmediateParentOf(u)){const c=this.getFieldsMap(e);this.applyChanges(c,n,s),n={},s=[],e=u.popLast()}a?n[u.lastSegment()]=Kr(a):s.push(u.lastSegment())}));const i=this.getFieldsMap(e);this.applyChanges(i,n,s)}delete(t){const e=this.field(t.popLast());Xs(e)&&e.mapValue.fields&&delete e.mapValue.fields[t.lastSegment()]}isEqual(t){return se(this.value,t.value)}getFieldsMap(t){let e=this.value;e.mapValue.fields||(e.mapValue={fields:{}});for(let n=0;n<t.length;++n){let s=e.mapValue.fields[t.get(n)];Xs(s)&&s.mapValue.fields||(s={mapValue:{fields:{}}},e.mapValue.fields[t.get(n)]=s),e=s}return e.mapValue.fields}applyChanges(t,e,n){qe(e,((s,i)=>t[s]=i));for(const s of n)delete t[s]}clone(){return new vt(Kr(this.value))}}function Ah(r){const t=[];return qe(r.fields,((e,n)=>{const s=new ct([e]);if(Xs(n)){const i=Ah(n.mapValue).fields;if(i.length===0)t.push(s);else for(const a of i)t.push(s.child(a))}else t.push(s)})),new Ot(t)}/**
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
 */class at{constructor(t,e,n,s,i,a,u){this.key=t,this.documentType=e,this.version=n,this.readTime=s,this.createTime=i,this.data=a,this.documentState=u}static newInvalidDocument(t){return new at(t,0,B.min(),B.min(),B.min(),vt.empty(),0)}static newFoundDocument(t,e,n,s){return new at(t,1,e,B.min(),n,s,0)}static newNoDocument(t,e){return new at(t,2,e,B.min(),B.min(),vt.empty(),0)}static newUnknownDocument(t,e){return new at(t,3,e,B.min(),B.min(),vt.empty(),2)}convertToFoundDocument(t,e){return!this.createTime.isEqual(B.min())||this.documentType!==2&&this.documentType!==0||(this.createTime=t),this.version=t,this.documentType=1,this.data=e,this.documentState=0,this}convertToNoDocument(t){return this.version=t,this.documentType=2,this.data=vt.empty(),this.documentState=0,this}convertToUnknownDocument(t){return this.version=t,this.documentType=3,this.data=vt.empty(),this.documentState=2,this}setHasCommittedMutations(){return this.documentState=2,this}setHasLocalMutations(){return this.documentState=1,this.version=B.min(),this}setReadTime(t){return this.readTime=t,this}get hasLocalMutations(){return this.documentState===1}get hasCommittedMutations(){return this.documentState===2}get hasPendingWrites(){return this.hasLocalMutations||this.hasCommittedMutations}isValidDocument(){return this.documentType!==0}isFoundDocument(){return this.documentType===1}isNoDocument(){return this.documentType===2}isUnknownDocument(){return this.documentType===3}isEqual(t){return t instanceof at&&this.key.isEqual(t.key)&&this.version.isEqual(t.version)&&this.documentType===t.documentType&&this.documentState===t.documentState&&this.data.isEqual(t.data)}mutableCopy(){return new at(this.key,this.documentType,this.version,this.readTime,this.createTime,this.data.clone(),this.documentState)}toString(){return`Document(${this.key}, ${this.version}, ${JSON.stringify(this.data.value)}, {createTime: ${this.createTime}}), {documentType: ${this.documentType}}), {documentState: ${this.documentState}})`}}/**
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
 */class Ne{constructor(t,e){this.position=t,this.inclusive=e}}function Sc(r,t,e){let n=0;for(let s=0;s<r.position.length;s++){const i=t[s],a=r.position[s];if(i.field.isKeyField()?n=k.comparator(k.fromName(a.referenceValue),e.key):n=De(a,e.data.field(i.field)),i.dir==="desc"&&(n*=-1),n!==0)break}return n}function Vc(r,t){if(r===null)return t===null;if(t===null||r.inclusive!==t.inclusive||r.position.length!==t.position.length)return!1;for(let e=0;e<r.position.length;e++)if(!se(r.position[e],t.position[e]))return!1;return!0}/**
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
 */class ss{constructor(t,e="asc"){this.field=t,this.dir=e}}function mg(r,t){return r.dir===t.dir&&r.field.isEqual(t.field)}/**
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
 */class vh{}class W extends vh{constructor(t,e,n){super(),this.field=t,this.op=e,this.value=n}static create(t,e,n){return t.isKeyField()?e==="in"||e==="not-in"?this.createKeyFieldInFilter(t,e,n):new gg(t,e,n):e==="array-contains"?new yg(t,n):e==="in"?new Ch(t,n):e==="not-in"?new Ig(t,n):e==="array-contains-any"?new Tg(t,n):new W(t,e,n)}static createKeyFieldInFilter(t,e,n){return e==="in"?new pg(t,n):new _g(t,n)}matches(t){const e=t.data.field(this.field);return this.op==="!="?e!==null&&e.nullValue===void 0&&this.matchesComparison(De(e,this.value)):e!==null&&xe(this.value)===xe(e)&&this.matchesComparison(De(e,this.value))}matchesComparison(t){switch(this.op){case"<":return t<0;case"<=":return t<=0;case"==":return t===0;case"!=":return t!==0;case">":return t>0;case">=":return t>=0;default:return O(47266,{operator:this.op})}}isInequality(){return["<","<=",">",">=","!=","not-in"].indexOf(this.op)>=0}getFlattenedFilters(){return[this]}getFilters(){return[this]}}class tt extends vh{constructor(t,e){super(),this.filters=t,this.op=e,this.Pe=null}static create(t,e){return new tt(t,e)}matches(t){return Wn(this)?this.filters.find((e=>!e.matches(t)))===void 0:this.filters.find((e=>e.matches(t)))!==void 0}getFlattenedFilters(){return this.Pe!==null||(this.Pe=this.filters.reduce(((t,e)=>t.concat(e.getFlattenedFilters())),[])),this.Pe}getFilters(){return Object.assign([],this.filters)}}function Wn(r){return r.op==="and"}function Oo(r){return r.op==="or"}function ha(r){return Rh(r)&&Wn(r)}function Rh(r){for(const t of r.filters)if(t instanceof tt)return!1;return!0}function Lo(r){if(r instanceof W)return r.field.canonicalString()+r.op.toString()+Qn(r.value);if(ha(r))return r.filters.map((t=>Lo(t))).join(",");{const t=r.filters.map((e=>Lo(e))).join(",");return`${r.op}(${t})`}}function Ph(r,t){return r instanceof W?(function(n,s){return s instanceof W&&n.op===s.op&&n.field.isEqual(s.field)&&se(n.value,s.value)})(r,t):r instanceof tt?(function(n,s){return s instanceof tt&&n.op===s.op&&n.filters.length===s.filters.length?n.filters.reduce(((i,a,u)=>i&&Ph(a,s.filters[u])),!0):!1})(r,t):void O(19439)}function Sh(r,t){const e=r.filters.concat(t);return tt.create(e,r.op)}function Vh(r){return r instanceof W?(function(e){return`${e.field.canonicalString()} ${e.op} ${Qn(e.value)}`})(r):r instanceof tt?(function(e){return e.op.toString()+" {"+e.getFilters().map(Vh).join(" ,")+"}"})(r):"Filter"}class gg extends W{constructor(t,e,n){super(t,e,n),this.key=k.fromName(n.referenceValue)}matches(t){const e=k.comparator(t.key,this.key);return this.matchesComparison(e)}}class pg extends W{constructor(t,e){super(t,"in",e),this.keys=bh("in",e)}matches(t){return this.keys.some((e=>e.isEqual(t.key)))}}class _g extends W{constructor(t,e){super(t,"not-in",e),this.keys=bh("not-in",e)}matches(t){return!this.keys.some((e=>e.isEqual(t.key)))}}function bh(r,t){var e;return(((e=t.arrayValue)==null?void 0:e.values)||[]).map((n=>k.fromName(n.referenceValue)))}class yg extends W{constructor(t,e){super(t,"array-contains",e)}matches(t){const e=t.data.field(this.field);return rs(e)&&ns(e.arrayValue,this.value)}}class Ch extends W{constructor(t,e){super(t,"in",e)}matches(t){const e=t.data.field(this.field);return e!==null&&ns(this.value.arrayValue,e)}}class Ig extends W{constructor(t,e){super(t,"not-in",e)}matches(t){if(ns(this.value.arrayValue,{nullValue:"NULL_VALUE"}))return!1;const e=t.data.field(this.field);return e!==null&&e.nullValue===void 0&&!ns(this.value.arrayValue,e)}}class Tg extends W{constructor(t,e){super(t,"array-contains-any",e)}matches(t){const e=t.data.field(this.field);return!(!rs(e)||!e.arrayValue.values)&&e.arrayValue.values.some((n=>ns(this.value.arrayValue,n)))}}/**
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
 */class Eg{constructor(t,e=null,n=[],s=[],i=null,a=null,u=null){this.path=t,this.collectionGroup=e,this.orderBy=n,this.filters=s,this.limit=i,this.startAt=a,this.endAt=u,this.Te=null}}function qo(r,t=null,e=[],n=[],s=null,i=null,a=null){return new Eg(r,t,e,n,s,i,a)}function cn(r){const t=F(r);if(t.Te===null){let e=t.path.canonicalString();t.collectionGroup!==null&&(e+="|cg:"+t.collectionGroup),e+="|f:",e+=t.filters.map((n=>Lo(n))).join(","),e+="|ob:",e+=t.orderBy.map((n=>(function(i){return i.field.canonicalString()+i.dir})(n))).join(","),ls(t.limit)||(e+="|l:",e+=t.limit),t.startAt&&(e+="|lb:",e+=t.startAt.inclusive?"b:":"a:",e+=t.startAt.position.map((n=>Qn(n))).join(",")),t.endAt&&(e+="|ub:",e+=t.endAt.inclusive?"a:":"b:",e+=t.endAt.position.map((n=>Qn(n))).join(",")),t.Te=e}return t.Te}function ds(r,t){if(r.limit!==t.limit||r.orderBy.length!==t.orderBy.length)return!1;for(let e=0;e<r.orderBy.length;e++)if(!mg(r.orderBy[e],t.orderBy[e]))return!1;if(r.filters.length!==t.filters.length)return!1;for(let e=0;e<r.filters.length;e++)if(!Ph(r.filters[e],t.filters[e]))return!1;return r.collectionGroup===t.collectionGroup&&!!r.path.isEqual(t.path)&&!!Vc(r.startAt,t.startAt)&&Vc(r.endAt,t.endAt)}function ui(r){return k.isDocumentKey(r.path)&&r.collectionGroup===null&&r.filters.length===0}function ci(r,t){return r.filters.filter((e=>e instanceof W&&e.field.isEqual(t)))}function bc(r,t,e){let n=Js,s=!0;for(const i of ci(r,t)){let a=Js,u=!0;switch(i.op){case"<":case"<=":a=dg(i.value);break;case"==":case"in":case">=":a=i.value;break;case">":a=i.value,u=!1;break;case"!=":case"not-in":a=Js}Rc({value:n,inclusive:s},{value:a,inclusive:u})<0&&(n=a,s=u)}if(e!==null){for(let i=0;i<r.orderBy.length;++i)if(r.orderBy[i].field.isEqual(t)){const a=e.position[i];Rc({value:n,inclusive:s},{value:a,inclusive:e.inclusive})<0&&(n=a,s=e.inclusive);break}}return{value:n,inclusive:s}}function Cc(r,t,e){let n=Re,s=!0;for(const i of ci(r,t)){let a=Re,u=!0;switch(i.op){case">=":case">":a=fg(i.value),u=!1;break;case"==":case"in":case"<=":a=i.value;break;case"<":a=i.value,u=!1;break;case"!=":case"not-in":a=Re}Pc({value:n,inclusive:s},{value:a,inclusive:u})>0&&(n=a,s=u)}if(e!==null){for(let i=0;i<r.orderBy.length;++i)if(r.orderBy[i].field.isEqual(t)){const a=e.position[i];Pc({value:n,inclusive:s},{value:a,inclusive:e.inclusive})>0&&(n=a,s=e.inclusive);break}}return{value:n,inclusive:s}}/**
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
 */class le{constructor(t,e=null,n=[],s=[],i=null,a="F",u=null,c=null){this.path=t,this.collectionGroup=e,this.explicitOrderBy=n,this.filters=s,this.limit=i,this.limitType=a,this.startAt=u,this.endAt=c,this.Ie=null,this.Ee=null,this.Re=null,this.startAt,this.endAt}}function xh(r,t,e,n,s,i,a,u){return new le(r,t,e,n,s,i,a,u)}function ir(r){return new le(r)}function xc(r){return r.filters.length===0&&r.limit===null&&r.startAt==null&&r.endAt==null&&(r.explicitOrderBy.length===0||r.explicitOrderBy.length===1&&r.explicitOrderBy[0].field.isKeyField())}function wg(r){return k.isDocumentKey(r.path)&&r.collectionGroup===null&&r.filters.length===0}function da(r){return r.collectionGroup!==null}function Fn(r){const t=F(r);if(t.Ie===null){t.Ie=[];const e=new Set;for(const i of t.explicitOrderBy)t.Ie.push(i),e.add(i.field.canonicalString());const n=t.explicitOrderBy.length>0?t.explicitOrderBy[t.explicitOrderBy.length-1].dir:"asc";(function(a){let u=new et(ct.comparator);return a.filters.forEach((c=>{c.getFlattenedFilters().forEach((h=>{h.isInequality()&&(u=u.add(h.field))}))})),u})(t).forEach((i=>{e.has(i.canonicalString())||i.isKeyField()||t.Ie.push(new ss(i,n))})),e.has(ct.keyField().canonicalString())||t.Ie.push(new ss(ct.keyField(),n))}return t.Ie}function Dt(r){const t=F(r);return t.Ee||(t.Ee=Nh(t,Fn(r))),t.Ee}function Dh(r){const t=F(r);return t.Re||(t.Re=Nh(t,r.explicitOrderBy)),t.Re}function Nh(r,t){if(r.limitType==="F")return qo(r.path,r.collectionGroup,t,r.filters,r.limit,r.startAt,r.endAt);{t=t.map((s=>{const i=s.dir==="desc"?"asc":"desc";return new ss(s.field,i)}));const e=r.endAt?new Ne(r.endAt.position,r.endAt.inclusive):null,n=r.startAt?new Ne(r.startAt.position,r.startAt.inclusive):null;return qo(r.path,r.collectionGroup,t,r.filters,r.limit,e,n)}}function Bo(r,t){const e=r.filters.concat([t]);return new le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),e,r.limit,r.limitType,r.startAt,r.endAt)}function Ag(r,t){const e=r.explicitOrderBy.concat([t]);return new le(r.path,r.collectionGroup,e,r.filters.slice(),r.limit,r.limitType,r.startAt,r.endAt)}function li(r,t,e){return new le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),r.filters.slice(),t,e,r.startAt,r.endAt)}function vg(r,t){return new le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),r.filters.slice(),r.limit,r.limitType,t,r.endAt)}function Rg(r,t){return new le(r.path,r.collectionGroup,r.explicitOrderBy.slice(),r.filters.slice(),r.limit,r.limitType,r.startAt,t)}function fs(r,t){return ds(Dt(r),Dt(t))&&r.limitType===t.limitType}function kh(r){return`${cn(Dt(r))}|lt:${r.limitType}`}function Dn(r){return`Query(target=${(function(e){let n=e.path.canonicalString();return e.collectionGroup!==null&&(n+=" collectionGroup="+e.collectionGroup),e.filters.length>0&&(n+=`, filters: [${e.filters.map((s=>Vh(s))).join(", ")}]`),ls(e.limit)||(n+=", limit: "+e.limit),e.orderBy.length>0&&(n+=`, orderBy: [${e.orderBy.map((s=>(function(a){return`${a.field.canonicalString()} (${a.dir})`})(s))).join(", ")}]`),e.startAt&&(n+=", startAt: ",n+=e.startAt.inclusive?"b:":"a:",n+=e.startAt.position.map((s=>Qn(s))).join(",")),e.endAt&&(n+=", endAt: ",n+=e.endAt.inclusive?"a:":"b:",n+=e.endAt.position.map((s=>Qn(s))).join(",")),`Target(${n})`})(Dt(r))}; limitType=${r.limitType})`}function ms(r,t){return t.isFoundDocument()&&(function(n,s){const i=s.key.path;return n.collectionGroup!==null?s.key.hasCollectionId(n.collectionGroup)&&n.path.isPrefixOf(i):k.isDocumentKey(n.path)?n.path.isEqual(i):n.path.isImmediateParentOf(i)})(r,t)&&(function(n,s){for(const i of Fn(n))if(!i.field.isKeyField()&&s.data.field(i.field)===null)return!1;return!0})(r,t)&&(function(n,s){for(const i of n.filters)if(!i.matches(s))return!1;return!0})(r,t)&&(function(n,s){return!(n.startAt&&!(function(a,u,c){const h=Sc(a,u,c);return a.inclusive?h<=0:h<0})(n.startAt,Fn(n),s)||n.endAt&&!(function(a,u,c){const h=Sc(a,u,c);return a.inclusive?h>=0:h>0})(n.endAt,Fn(n),s))})(r,t)}function Fh(r){return r.collectionGroup||(r.path.length%2==1?r.path.lastSegment():r.path.get(r.path.length-2))}function Mh(r){return(t,e)=>{let n=!1;for(const s of Fn(r)){const i=Pg(s,t,e);if(i!==0)return i;n=n||s.field.isKeyField()}return 0}}function Pg(r,t,e){const n=r.field.isKeyField()?k.comparator(t.key,e.key):(function(i,a,u){const c=a.data.field(i),h=u.data.field(i);return c!==null&&h!==null?De(c,h):O(42886)})(r.field,t,e);switch(r.dir){case"asc":return n;case"desc":return-1*n;default:return O(19790,{direction:r.dir})}}/**
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
 */class he{constructor(t,e){this.mapKeyFn=t,this.equalsFn=e,this.inner={},this.innerSize=0}get(t){const e=this.mapKeyFn(t),n=this.inner[e];if(n!==void 0){for(const[s,i]of n)if(this.equalsFn(s,t))return i}}has(t){return this.get(t)!==void 0}set(t,e){const n=this.mapKeyFn(t),s=this.inner[n];if(s===void 0)return this.inner[n]=[[t,e]],void this.innerSize++;for(let i=0;i<s.length;i++)if(this.equalsFn(s[i][0],t))return void(s[i]=[t,e]);s.push([t,e]),this.innerSize++}delete(t){const e=this.mapKeyFn(t),n=this.inner[e];if(n===void 0)return!1;for(let s=0;s<n.length;s++)if(this.equalsFn(n[s][0],t))return n.length===1?delete this.inner[e]:n.splice(s,1),this.innerSize--,!0;return!1}forEach(t){qe(this.inner,((e,n)=>{for(const[s,i]of n)t(s,i)}))}isEmpty(){return mh(this.inner)}size(){return this.innerSize}}/**
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
 */const Sg=new it(k.comparator);function Lt(){return Sg}const Oh=new it(k.comparator);function Lr(...r){let t=Oh;for(const e of r)t=t.insert(e.key,e);return t}function Lh(r){let t=Oh;return r.forEach(((e,n)=>t=t.insert(e,n.overlayedDocument))),t}function Zt(){return $r()}function qh(){return $r()}function $r(){return new he((r=>r.toString()),((r,t)=>r.isEqual(t)))}const Vg=new it(k.comparator),bg=new et(k.comparator);function G(...r){let t=bg;for(const e of r)t=t.add(e);return t}const Cg=new et(z);function fa(){return Cg}/**
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
 */function ma(r,t){if(r.useProto3Json){if(isNaN(t))return{doubleValue:"NaN"};if(t===1/0)return{doubleValue:"Infinity"};if(t===-1/0)return{doubleValue:"-Infinity"}}return{doubleValue:Jr(t)?"-0":t}}function Bh(r){return{integerValue:""+r}}function Uh(r,t){return nh(t)?Bh(t):ma(r,t)}/**
 * @license
 * Copyright 2018 Google LLC
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
 */class Vi{constructor(){this._=void 0}}function xg(r,t,e){return r instanceof Hn?(function(s,i){const a={fields:{[_h]:{stringValue:ph},[Ih]:{timestampValue:{seconds:s.seconds,nanos:s.nanoseconds}}}};return i&&Ri(i)&&(i=Pi(i)),i&&(a.fields[yh]=i),{mapValue:a}})(e,t):r instanceof ln?zh(r,t):r instanceof hn?Gh(r,t):(function(s,i){const a=jh(s,i),u=Dc(a)+Dc(s.Ae);return Mo(a)&&Mo(s.Ae)?Bh(u):ma(s.serializer,u)})(r,t)}function Dg(r,t,e){return r instanceof ln?zh(r,t):r instanceof hn?Gh(r,t):e}function jh(r,t){return r instanceof Jn?(function(n){return Mo(n)||(function(i){return!!i&&"doubleValue"in i})(n)})(t)?t:{integerValue:0}:null}class Hn extends Vi{}class ln extends Vi{constructor(t){super(),this.elements=t}}function zh(r,t){const e=Kh(t);for(const n of r.elements)e.some((s=>se(s,n)))||e.push(n);return{arrayValue:{values:e}}}class hn extends Vi{constructor(t){super(),this.elements=t}}function Gh(r,t){let e=Kh(t);for(const n of r.elements)e=e.filter((s=>!se(s,n)));return{arrayValue:{values:e}}}class Jn extends Vi{constructor(t,e){super(),this.serializer=t,this.Ae=e}}function Dc(r){return ut(r.integerValue||r.doubleValue)}function Kh(r){return rs(r)&&r.arrayValue.values?r.arrayValue.values.slice():[]}/**
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
 */class gs{constructor(t,e){this.field=t,this.transform=e}}function Ng(r,t){return r.field.isEqual(t.field)&&(function(n,s){return n instanceof ln&&s instanceof ln||n instanceof hn&&s instanceof hn?Ln(n.elements,s.elements,se):n instanceof Jn&&s instanceof Jn?se(n.Ae,s.Ae):n instanceof Hn&&s instanceof Hn})(r.transform,t.transform)}class kg{constructor(t,e){this.version=t,this.transformResults=e}}class lt{constructor(t,e){this.updateTime=t,this.exists=e}static none(){return new lt}static exists(t){return new lt(void 0,t)}static updateTime(t){return new lt(t)}get isNone(){return this.updateTime===void 0&&this.exists===void 0}isEqual(t){return this.exists===t.exists&&(this.updateTime?!!t.updateTime&&this.updateTime.isEqual(t.updateTime):!t.updateTime)}}function Zs(r,t){return r.updateTime!==void 0?t.isFoundDocument()&&t.version.isEqual(r.updateTime):r.exists===void 0||r.exists===t.isFoundDocument()}class bi{}function $h(r,t){if(!r.hasLocalMutations||t&&t.fields.length===0)return null;if(t===null)return r.isNoDocument()?new ar(r.key,lt.none()):new or(r.key,r.data,lt.none());{const e=r.data,n=vt.empty();let s=new et(ct.comparator);for(let i of t.fields)if(!s.has(i)){let a=e.field(i);a===null&&i.length>1&&(i=i.popLast(),a=e.field(i)),a===null?n.delete(i):n.set(i,a),s=s.add(i)}return new de(r.key,n,new Ot(s.toArray()),lt.none())}}function Fg(r,t,e){r instanceof or?(function(s,i,a){const u=s.value.clone(),c=kc(s.fieldTransforms,i,a.transformResults);u.setAll(c),i.convertToFoundDocument(a.version,u).setHasCommittedMutations()})(r,t,e):r instanceof de?(function(s,i,a){if(!Zs(s.precondition,i))return void i.convertToUnknownDocument(a.version);const u=kc(s.fieldTransforms,i,a.transformResults),c=i.data;c.setAll(Qh(s)),c.setAll(u),i.convertToFoundDocument(a.version,c).setHasCommittedMutations()})(r,t,e):(function(s,i,a){i.convertToNoDocument(a.version).setHasCommittedMutations()})(0,t,e)}function Qr(r,t,e,n){return r instanceof or?(function(i,a,u,c){if(!Zs(i.precondition,a))return u;const h=i.value.clone(),f=Fc(i.fieldTransforms,c,a);return h.setAll(f),a.convertToFoundDocument(a.version,h).setHasLocalMutations(),null})(r,t,e,n):r instanceof de?(function(i,a,u,c){if(!Zs(i.precondition,a))return u;const h=Fc(i.fieldTransforms,c,a),f=a.data;return f.setAll(Qh(i)),f.setAll(h),a.convertToFoundDocument(a.version,f).setHasLocalMutations(),u===null?null:u.unionWith(i.fieldMask.fields).unionWith(i.fieldTransforms.map((m=>m.field)))})(r,t,e,n):(function(i,a,u){return Zs(i.precondition,a)?(a.convertToNoDocument(a.version).setHasLocalMutations(),null):u})(r,t,e)}function Mg(r,t){let e=null;for(const n of r.fieldTransforms){const s=t.data.field(n.field),i=jh(n.transform,s||null);i!=null&&(e===null&&(e=vt.empty()),e.set(n.field,i))}return e||null}function Nc(r,t){return r.type===t.type&&!!r.key.isEqual(t.key)&&!!r.precondition.isEqual(t.precondition)&&!!(function(n,s){return n===void 0&&s===void 0||!(!n||!s)&&Ln(n,s,((i,a)=>Ng(i,a)))})(r.fieldTransforms,t.fieldTransforms)&&(r.type===0?r.value.isEqual(t.value):r.type!==1||r.data.isEqual(t.data)&&r.fieldMask.isEqual(t.fieldMask))}class or extends bi{constructor(t,e,n,s=[]){super(),this.key=t,this.value=e,this.precondition=n,this.fieldTransforms=s,this.type=0}getFieldMask(){return null}}class de extends bi{constructor(t,e,n,s,i=[]){super(),this.key=t,this.data=e,this.fieldMask=n,this.precondition=s,this.fieldTransforms=i,this.type=1}getFieldMask(){return this.fieldMask}}function Qh(r){const t=new Map;return r.fieldMask.fields.forEach((e=>{if(!e.isEmpty()){const n=r.data.field(e);t.set(e,n)}})),t}function kc(r,t,e){const n=new Map;L(r.length===e.length,32656,{Ve:e.length,de:r.length});for(let s=0;s<e.length;s++){const i=r[s],a=i.transform,u=t.data.field(i.field);n.set(i.field,Dg(a,u,e[s]))}return n}function Fc(r,t,e){const n=new Map;for(const s of r){const i=s.transform,a=e.data.field(s.field);n.set(s.field,xg(i,a,t))}return n}class ar extends bi{constructor(t,e){super(),this.key=t,this.precondition=e,this.type=2,this.fieldTransforms=[]}getFieldMask(){return null}}class ga extends bi{constructor(t,e){super(),this.key=t,this.precondition=e,this.type=3,this.fieldTransforms=[]}getFieldMask(){return null}}/**
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
 */class pa{constructor(t,e,n,s){this.batchId=t,this.localWriteTime=e,this.baseMutations=n,this.mutations=s}applyToRemoteDocument(t,e){const n=e.mutationResults;for(let s=0;s<this.mutations.length;s++){const i=this.mutations[s];i.key.isEqual(t.key)&&Fg(i,t,n[s])}}applyToLocalView(t,e){for(const n of this.baseMutations)n.key.isEqual(t.key)&&(e=Qr(n,t,e,this.localWriteTime));for(const n of this.mutations)n.key.isEqual(t.key)&&(e=Qr(n,t,e,this.localWriteTime));return e}applyToLocalDocumentSet(t,e){const n=qh();return this.mutations.forEach((s=>{const i=t.get(s.key),a=i.overlayedDocument;let u=this.applyToLocalView(a,i.mutatedFields);u=e.has(s.key)?null:u;const c=$h(a,u);c!==null&&n.set(s.key,c),a.isValidDocument()||a.convertToNoDocument(B.min())})),n}keys(){return this.mutations.reduce(((t,e)=>t.add(e.key)),G())}isEqual(t){return this.batchId===t.batchId&&Ln(this.mutations,t.mutations,((e,n)=>Nc(e,n)))&&Ln(this.baseMutations,t.baseMutations,((e,n)=>Nc(e,n)))}}class _a{constructor(t,e,n,s){this.batch=t,this.commitVersion=e,this.mutationResults=n,this.docVersions=s}static from(t,e,n){L(t.mutations.length===n.length,58842,{me:t.mutations.length,fe:n.length});let s=(function(){return Vg})();const i=t.mutations;for(let a=0;a<i.length;a++)s=s.insert(i[a].key,n[a].version);return new _a(t,e,n,s)}}/**
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
 */class ya{constructor(t,e){this.largestBatchId=t,this.mutation=e}getKey(){return this.mutation.key}isEqual(t){return t!==null&&this.mutation===t.mutation}toString(){return`Overlay{
      largestBatchId: ${this.largestBatchId},
      mutation: ${this.mutation.toString()}
    }`}}/**
 * @license
 * Copyright 2023 Google LLC
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
 */class Wh{constructor(t,e,n){this.alias=t,this.aggregateType=e,this.fieldPath=n}}/**
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
 */class Og{constructor(t,e){this.count=t,this.unchangedNames=e}}/**
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
 */var pt,H;function Hh(r){switch(r){case P.OK:return O(64938);case P.CANCELLED:case P.UNKNOWN:case P.DEADLINE_EXCEEDED:case P.RESOURCE_EXHAUSTED:case P.INTERNAL:case P.UNAVAILABLE:case P.UNAUTHENTICATED:return!1;case P.INVALID_ARGUMENT:case P.NOT_FOUND:case P.ALREADY_EXISTS:case P.PERMISSION_DENIED:case P.FAILED_PRECONDITION:case P.ABORTED:case P.OUT_OF_RANGE:case P.UNIMPLEMENTED:case P.DATA_LOSS:return!0;default:return O(15467,{code:r})}}function Jh(r){if(r===void 0)return mt("GRPC error has no .code"),P.UNKNOWN;switch(r){case pt.OK:return P.OK;case pt.CANCELLED:return P.CANCELLED;case pt.UNKNOWN:return P.UNKNOWN;case pt.DEADLINE_EXCEEDED:return P.DEADLINE_EXCEEDED;case pt.RESOURCE_EXHAUSTED:return P.RESOURCE_EXHAUSTED;case pt.INTERNAL:return P.INTERNAL;case pt.UNAVAILABLE:return P.UNAVAILABLE;case pt.UNAUTHENTICATED:return P.UNAUTHENTICATED;case pt.INVALID_ARGUMENT:return P.INVALID_ARGUMENT;case pt.NOT_FOUND:return P.NOT_FOUND;case pt.ALREADY_EXISTS:return P.ALREADY_EXISTS;case pt.PERMISSION_DENIED:return P.PERMISSION_DENIED;case pt.FAILED_PRECONDITION:return P.FAILED_PRECONDITION;case pt.ABORTED:return P.ABORTED;case pt.OUT_OF_RANGE:return P.OUT_OF_RANGE;case pt.UNIMPLEMENTED:return P.UNIMPLEMENTED;case pt.DATA_LOSS:return P.DATA_LOSS;default:return O(39323,{code:r})}}(H=pt||(pt={}))[H.OK=0]="OK",H[H.CANCELLED=1]="CANCELLED",H[H.UNKNOWN=2]="UNKNOWN",H[H.INVALID_ARGUMENT=3]="INVALID_ARGUMENT",H[H.DEADLINE_EXCEEDED=4]="DEADLINE_EXCEEDED",H[H.NOT_FOUND=5]="NOT_FOUND",H[H.ALREADY_EXISTS=6]="ALREADY_EXISTS",H[H.PERMISSION_DENIED=7]="PERMISSION_DENIED",H[H.UNAUTHENTICATED=16]="UNAUTHENTICATED",H[H.RESOURCE_EXHAUSTED=8]="RESOURCE_EXHAUSTED",H[H.FAILED_PRECONDITION=9]="FAILED_PRECONDITION",H[H.ABORTED=10]="ABORTED",H[H.OUT_OF_RANGE=11]="OUT_OF_RANGE",H[H.UNIMPLEMENTED=12]="UNIMPLEMENTED",H[H.INTERNAL=13]="INTERNAL",H[H.UNAVAILABLE=14]="UNAVAILABLE",H[H.DATA_LOSS=15]="DATA_LOSS";/**
 * @license
 * Copyright 2023 Google LLC
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
 */let Wr=null;function Lg(r){if(Wr)throw new Error("a TestingHooksSpi instance is already set");Wr=r}/**
 * @license
 * Copyright 2023 Google LLC
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
 */function Yh(){return new TextEncoder}/**
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
 */const qg=new Ve([4294967295,4294967295],0);function Mc(r){const t=Yh().encode(r),e=new Bl;return e.update(t),new Uint8Array(e.digest())}function Oc(r){const t=new DataView(r.buffer),e=t.getUint32(0,!0),n=t.getUint32(4,!0),s=t.getUint32(8,!0),i=t.getUint32(12,!0);return[new Ve([e,n],0),new Ve([s,i],0)]}class Ia{constructor(t,e,n){if(this.bitmap=t,this.padding=e,this.hashCount=n,e<0||e>=8)throw new qr(`Invalid padding: ${e}`);if(n<0)throw new qr(`Invalid hash count: ${n}`);if(t.length>0&&this.hashCount===0)throw new qr(`Invalid hash count: ${n}`);if(t.length===0&&e!==0)throw new qr(`Invalid padding when bitmap length is 0: ${e}`);this.ge=8*t.length-e,this.pe=Ve.fromNumber(this.ge)}ye(t,e,n){let s=t.add(e.multiply(Ve.fromNumber(n)));return s.compare(qg)===1&&(s=new Ve([s.getBits(0),s.getBits(1)],0)),s.modulo(this.pe).toNumber()}we(t){return!!(this.bitmap[Math.floor(t/8)]&1<<t%8)}mightContain(t){if(this.ge===0)return!1;const e=Mc(t),[n,s]=Oc(e);for(let i=0;i<this.hashCount;i++){const a=this.ye(n,s,i);if(!this.we(a))return!1}return!0}static create(t,e,n){const s=t%8==0?0:8-t%8,i=new Uint8Array(Math.ceil(t/8)),a=new Ia(i,s,e);return n.forEach((u=>a.insert(u))),a}insert(t){if(this.ge===0)return;const e=Mc(t),[n,s]=Oc(e);for(let i=0;i<this.hashCount;i++){const a=this.ye(n,s,i);this.be(a)}}be(t){const e=Math.floor(t/8),n=t%8;this.bitmap[e]|=1<<n}}class qr extends Error{constructor(){super(...arguments),this.name="BloomFilterError"}}/**
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
 */class ps{constructor(t,e,n,s,i){this.snapshotVersion=t,this.targetChanges=e,this.targetMismatches=n,this.documentUpdates=s,this.resolvedLimboDocuments=i}static createSynthesizedRemoteEventForCurrentChange(t,e,n){const s=new Map;return s.set(t,_s.createSynthesizedTargetChangeForCurrentChange(t,e,n)),new ps(B.min(),s,new it(z),Lt(),G())}}class _s{constructor(t,e,n,s,i){this.resumeToken=t,this.current=e,this.addedDocuments=n,this.modifiedDocuments=s,this.removedDocuments=i}static createSynthesizedTargetChangeForCurrentChange(t,e,n){return new _s(n,e,G(),G(),G())}}/**
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
 */class ti{constructor(t,e,n,s){this.Se=t,this.removedTargetIds=e,this.key=n,this.De=s}}class Xh{constructor(t,e){this.targetId=t,this.Ce=e}}class Zh{constructor(t,e,n=ft.EMPTY_BYTE_STRING,s=null){this.state=t,this.targetIds=e,this.resumeToken=n,this.cause=s}}class Lc{constructor(){this.ve=0,this.Fe=qc(),this.Me=ft.EMPTY_BYTE_STRING,this.xe=!1,this.Oe=!0}get current(){return this.xe}get resumeToken(){return this.Me}get Ne(){return this.ve!==0}get Be(){return this.Oe}Le(t){t.approximateByteSize()>0&&(this.Oe=!0,this.Me=t)}ke(){let t=G(),e=G(),n=G();return this.Fe.forEach(((s,i)=>{switch(i){case 0:t=t.add(s);break;case 2:e=e.add(s);break;case 1:n=n.add(s);break;default:O(38017,{changeType:i})}})),new _s(this.Me,this.xe,t,e,n)}Ke(){this.Oe=!1,this.Fe=qc()}qe(t,e){this.Oe=!0,this.Fe=this.Fe.insert(t,e)}Ue(t){this.Oe=!0,this.Fe=this.Fe.remove(t)}$e(){this.ve+=1}We(){this.ve-=1,L(this.ve>=0,3241,{ve:this.ve})}Qe(){this.Oe=!0,this.xe=!0}}class Bg{constructor(t){this.Ge=t,this.ze=new Map,this.je=Lt(),this.He=Us(),this.Je=Us(),this.Ze=new it(z)}Xe(t){for(const e of t.Se)t.De&&t.De.isFoundDocument()?this.Ye(e,t.De):this.et(e,t.key,t.De);for(const e of t.removedTargetIds)this.et(e,t.key,t.De)}tt(t){this.forEachTarget(t,(e=>{const n=this.nt(e);switch(t.state){case 0:this.rt(e)&&n.Le(t.resumeToken);break;case 1:n.We(),n.Ne||n.Ke(),n.Le(t.resumeToken);break;case 2:n.We(),n.Ne||this.removeTarget(e);break;case 3:this.rt(e)&&(n.Qe(),n.Le(t.resumeToken));break;case 4:this.rt(e)&&(this.it(e),n.Le(t.resumeToken));break;default:O(56790,{state:t.state})}}))}forEachTarget(t,e){t.targetIds.length>0?t.targetIds.forEach(e):this.ze.forEach(((n,s)=>{this.rt(s)&&e(s)}))}st(t){const e=t.targetId,n=t.Ce.count,s=this.ot(e);if(s){const i=s.target;if(ui(i))if(n===0){const a=new k(i.path);this.et(e,a,at.newNoDocument(a,B.min()))}else L(n===1,20013,{expectedCount:n});else{const a=this._t(e);if(a!==n){const u=this.ut(t),c=u?this.ct(u,t,a):1;if(c!==0){this.it(e);const h=c===2?"TargetPurposeExistenceFilterMismatchBloom":"TargetPurposeExistenceFilterMismatch";this.Ze=this.Ze.insert(e,h)}Wr==null||Wr.lt((function(f,m,p,v,C){var q,j,U;const N={localCacheCount:f,existenceFilterCount:m.count,databaseId:p.database,projectId:p.projectId},D=m.unchangedNames;return D&&(N.bloomFilter={applied:C===0,hashCount:(D==null?void 0:D.hashCount)??0,bitmapLength:((j=(q=D==null?void 0:D.bits)==null?void 0:q.bitmap)==null?void 0:j.length)??0,padding:((U=D==null?void 0:D.bits)==null?void 0:U.padding)??0,mightContain:X=>(v==null?void 0:v.mightContain(X))??!1}),N})(a,t.Ce,this.Ge.ht(),u,c))}}}}ut(t){const e=t.Ce.unchangedNames;if(!e||!e.bits)return null;const{bits:{bitmap:n="",padding:s=0},hashCount:i=0}=e;let a,u;try{a=ue(n).toUint8Array()}catch(c){if(c instanceof gh)return Gt("Decoding the base64 bloom filter in existence filter failed ("+c.message+"); ignoring the bloom filter and falling back to full re-query."),null;throw c}try{u=new Ia(a,s,i)}catch(c){return Gt(c instanceof qr?"BloomFilter error: ":"Applying bloom filter failed: ",c),null}return u.ge===0?null:u}ct(t,e,n){return e.Ce.count===n-this.Pt(t,e.targetId)?0:2}Pt(t,e){const n=this.Ge.getRemoteKeysForTarget(e);let s=0;return n.forEach((i=>{const a=this.Ge.ht(),u=`projects/${a.projectId}/databases/${a.database}/documents/${i.path.canonicalString()}`;t.mightContain(u)||(this.et(e,i,null),s++)})),s}Tt(t){const e=new Map;this.ze.forEach(((i,a)=>{const u=this.ot(a);if(u){if(i.current&&ui(u.target)){const c=new k(u.target.path);this.It(c).has(a)||this.Et(a,c)||this.et(a,c,at.newNoDocument(c,t))}i.Be&&(e.set(a,i.ke()),i.Ke())}}));let n=G();this.Je.forEach(((i,a)=>{let u=!0;a.forEachWhile((c=>{const h=this.ot(c);return!h||h.purpose==="TargetPurposeLimboResolution"||(u=!1,!1)})),u&&(n=n.add(i))})),this.je.forEach(((i,a)=>a.setReadTime(t)));const s=new ps(t,e,this.Ze,this.je,n);return this.je=Lt(),this.He=Us(),this.Je=Us(),this.Ze=new it(z),s}Ye(t,e){if(!this.rt(t))return;const n=this.Et(t,e.key)?2:0;this.nt(t).qe(e.key,n),this.je=this.je.insert(e.key,e),this.He=this.He.insert(e.key,this.It(e.key).add(t)),this.Je=this.Je.insert(e.key,this.Rt(e.key).add(t))}et(t,e,n){if(!this.rt(t))return;const s=this.nt(t);this.Et(t,e)?s.qe(e,1):s.Ue(e),this.Je=this.Je.insert(e,this.Rt(e).delete(t)),this.Je=this.Je.insert(e,this.Rt(e).add(t)),n&&(this.je=this.je.insert(e,n))}removeTarget(t){this.ze.delete(t)}_t(t){const e=this.nt(t).ke();return this.Ge.getRemoteKeysForTarget(t).size+e.addedDocuments.size-e.removedDocuments.size}$e(t){this.nt(t).$e()}nt(t){let e=this.ze.get(t);return e||(e=new Lc,this.ze.set(t,e)),e}Rt(t){let e=this.Je.get(t);return e||(e=new et(z),this.Je=this.Je.insert(t,e)),e}It(t){let e=this.He.get(t);return e||(e=new et(z),this.He=this.He.insert(t,e)),e}rt(t){const e=this.ot(t)!==null;return e||x("WatchChangeAggregator","Detected inactive target",t),e}ot(t){const e=this.ze.get(t);return e&&e.Ne?null:this.Ge.At(t)}it(t){this.ze.set(t,new Lc),this.Ge.getRemoteKeysForTarget(t).forEach((e=>{this.et(t,e,null)}))}Et(t,e){return this.Ge.getRemoteKeysForTarget(t).has(e)}}function Us(){return new it(k.comparator)}function qc(){return new it(k.comparator)}const Ug={asc:"ASCENDING",desc:"DESCENDING"},jg={"<":"LESS_THAN","<=":"LESS_THAN_OR_EQUAL",">":"GREATER_THAN",">=":"GREATER_THAN_OR_EQUAL","==":"EQUAL","!=":"NOT_EQUAL","array-contains":"ARRAY_CONTAINS",in:"IN","not-in":"NOT_IN","array-contains-any":"ARRAY_CONTAINS_ANY"},zg={and:"AND",or:"OR"};class Gg{constructor(t,e){this.databaseId=t,this.useProto3Json=e}}function Uo(r,t){return r.useProto3Json||ls(t)?t:{value:t}}function Yn(r,t){return r.useProto3Json?`${new Date(1e3*t.seconds).toISOString().replace(/\.\d*/,"").replace("Z","")}.${("000000000"+t.nanoseconds).slice(-9)}Z`:{seconds:""+t.seconds,nanos:t.nanoseconds}}function td(r,t){return r.useProto3Json?t.toBase64():t.toUint8Array()}function Kg(r,t){return Yn(r,t.toTimestamp())}function gt(r){return L(!!r,49232),B.fromTimestamp((function(e){const n=ae(e);return new Z(n.seconds,n.nanos)})(r))}function Ta(r,t){return jo(r,t).canonicalString()}function jo(r,t){const e=(function(s){return new $(["projects",s.projectId,"databases",s.database])})(r).child("documents");return t===void 0?e:e.child(t)}function ed(r){const t=$.fromString(r);return L(ld(t),10190,{key:t.toString()}),t}function is(r,t){return Ta(r.databaseId,t.path)}function ee(r,t){const e=ed(t);if(e.get(1)!==r.databaseId.projectId)throw new b(P.INVALID_ARGUMENT,"Tried to deserialize key from different project: "+e.get(1)+" vs "+r.databaseId.projectId);if(e.get(3)!==r.databaseId.database)throw new b(P.INVALID_ARGUMENT,"Tried to deserialize key from different database: "+e.get(3)+" vs "+r.databaseId.database);return new k(sd(e))}function nd(r,t){return Ta(r.databaseId,t)}function rd(r){const t=ed(r);return t.length===4?$.emptyPath():sd(t)}function zo(r){return new $(["projects",r.databaseId.projectId,"databases",r.databaseId.database]).canonicalString()}function sd(r){return L(r.length>4&&r.get(4)==="documents",29091,{key:r.toString()}),r.popFirst(5)}function Bc(r,t,e){return{name:is(r,t),fields:e.value.mapValue.fields}}function Ci(r,t,e){const n=ee(r,t.name),s=gt(t.updateTime),i=t.createTime?gt(t.createTime):B.min(),a=new vt({mapValue:{fields:t.fields}}),u=at.newFoundDocument(n,s,i,a);return e&&u.setHasCommittedMutations(),e?u.setHasCommittedMutations():u}function $g(r,t){return"found"in t?(function(n,s){L(!!s.found,43571),s.found.name,s.found.updateTime;const i=ee(n,s.found.name),a=gt(s.found.updateTime),u=s.found.createTime?gt(s.found.createTime):B.min(),c=new vt({mapValue:{fields:s.found.fields}});return at.newFoundDocument(i,a,u,c)})(r,t):"missing"in t?(function(n,s){L(!!s.missing,3894),L(!!s.readTime,22933);const i=ee(n,s.missing),a=gt(s.readTime);return at.newNoDocument(i,a)})(r,t):O(7234,{result:t})}function Qg(r,t){let e;if("targetChange"in t){t.targetChange;const n=(function(h){return h==="NO_CHANGE"?0:h==="ADD"?1:h==="REMOVE"?2:h==="CURRENT"?3:h==="RESET"?4:O(39313,{state:h})})(t.targetChange.targetChangeType||"NO_CHANGE"),s=t.targetChange.targetIds||[],i=(function(h,f){return h.useProto3Json?(L(f===void 0||typeof f=="string",58123),ft.fromBase64String(f||"")):(L(f===void 0||f instanceof Buffer||f instanceof Uint8Array,16193),ft.fromUint8Array(f||new Uint8Array))})(r,t.targetChange.resumeToken),a=t.targetChange.cause,u=a&&(function(h){const f=h.code===void 0?P.UNKNOWN:Jh(h.code);return new b(f,h.message||"")})(a);e=new Zh(n,s,i,u||null)}else if("documentChange"in t){t.documentChange;const n=t.documentChange;n.document,n.document.name,n.document.updateTime;const s=ee(r,n.document.name),i=gt(n.document.updateTime),a=n.document.createTime?gt(n.document.createTime):B.min(),u=new vt({mapValue:{fields:n.document.fields}}),c=at.newFoundDocument(s,i,a,u),h=n.targetIds||[],f=n.removedTargetIds||[];e=new ti(h,f,c.key,c)}else if("documentDelete"in t){t.documentDelete;const n=t.documentDelete;n.document;const s=ee(r,n.document),i=n.readTime?gt(n.readTime):B.min(),a=at.newNoDocument(s,i),u=n.removedTargetIds||[];e=new ti([],u,a.key,a)}else if("documentRemove"in t){t.documentRemove;const n=t.documentRemove;n.document;const s=ee(r,n.document),i=n.removedTargetIds||[];e=new ti([],i,s,null)}else{if(!("filter"in t))return O(11601,{Vt:t});{t.filter;const n=t.filter;n.targetId;const{count:s=0,unchangedNames:i}=n,a=new Og(s,i),u=n.targetId;e=new Xh(u,a)}}return e}function os(r,t){let e;if(t instanceof or)e={update:Bc(r,t.key,t.value)};else if(t instanceof ar)e={delete:is(r,t.key)};else if(t instanceof de)e={update:Bc(r,t.key,t.data),updateMask:Zg(t.fieldMask)};else{if(!(t instanceof ga))return O(16599,{dt:t.type});e={verify:is(r,t.key)}}return t.fieldTransforms.length>0&&(e.updateTransforms=t.fieldTransforms.map((n=>(function(i,a){const u=a.transform;if(u instanceof Hn)return{fieldPath:a.field.canonicalString(),setToServerValue:"REQUEST_TIME"};if(u instanceof ln)return{fieldPath:a.field.canonicalString(),appendMissingElements:{values:u.elements}};if(u instanceof hn)return{fieldPath:a.field.canonicalString(),removeAllFromArray:{values:u.elements}};if(u instanceof Jn)return{fieldPath:a.field.canonicalString(),increment:u.Ae};throw O(20930,{transform:a.transform})})(0,n)))),t.precondition.isNone||(e.currentDocument=(function(s,i){return i.updateTime!==void 0?{updateTime:Kg(s,i.updateTime)}:i.exists!==void 0?{exists:i.exists}:O(27497)})(r,t.precondition)),e}function Go(r,t){const e=t.currentDocument?(function(i){return i.updateTime!==void 0?lt.updateTime(gt(i.updateTime)):i.exists!==void 0?lt.exists(i.exists):lt.none()})(t.currentDocument):lt.none(),n=t.updateTransforms?t.updateTransforms.map((s=>(function(a,u){let c=null;if("setToServerValue"in u)L(u.setToServerValue==="REQUEST_TIME",16630,{proto:u}),c=new Hn;else if("appendMissingElements"in u){const f=u.appendMissingElements.values||[];c=new ln(f)}else if("removeAllFromArray"in u){const f=u.removeAllFromArray.values||[];c=new hn(f)}else"increment"in u?c=new Jn(a,u.increment):O(16584,{proto:u});const h=ct.fromServerFormat(u.fieldPath);return new gs(h,c)})(r,s))):[];if(t.update){t.update.name;const s=ee(r,t.update.name),i=new vt({mapValue:{fields:t.update.fields}});if(t.updateMask){const a=(function(c){const h=c.fieldPaths||[];return new Ot(h.map((f=>ct.fromServerFormat(f))))})(t.updateMask);return new de(s,i,a,e,n)}return new or(s,i,e,n)}if(t.delete){const s=ee(r,t.delete);return new ar(s,e)}if(t.verify){const s=ee(r,t.verify);return new ga(s,e)}return O(1463,{proto:t})}function Wg(r,t){return r&&r.length>0?(L(t!==void 0,14353),r.map((e=>(function(s,i){let a=s.updateTime?gt(s.updateTime):gt(i);return a.isEqual(B.min())&&(a=gt(i)),new kg(a,s.transformResults||[])})(e,t)))):[]}function id(r,t){return{documents:[nd(r,t.path)]}}function xi(r,t){const e={structuredQuery:{}},n=t.path;let s;t.collectionGroup!==null?(s=n,e.structuredQuery.from=[{collectionId:t.collectionGroup,allDescendants:!0}]):(s=n.popLast(),e.structuredQuery.from=[{collectionId:n.lastSegment()}]),e.parent=nd(r,s);const i=(function(h){if(h.length!==0)return cd(tt.create(h,"and"))})(t.filters);i&&(e.structuredQuery.where=i);const a=(function(h){if(h.length!==0)return h.map((f=>(function(p){return{field:Ae(p.field),direction:Jg(p.dir)}})(f)))})(t.orderBy);a&&(e.structuredQuery.orderBy=a);const u=Uo(r,t.limit);return u!==null&&(e.structuredQuery.limit=u),t.startAt&&(e.structuredQuery.startAt=(function(h){return{before:h.inclusive,values:h.position}})(t.startAt)),t.endAt&&(e.structuredQuery.endAt=(function(h){return{before:!h.inclusive,values:h.position}})(t.endAt)),{ft:e,parent:s}}function od(r,t,e,n){const{ft:s,parent:i}=xi(r,t),a={},u=[];let c=0;return e.forEach((h=>{const f=n?h.alias:"aggregate_"+c++;a[f]=h.alias,h.aggregateType==="count"?u.push({alias:f,count:{}}):h.aggregateType==="avg"?u.push({alias:f,avg:{field:Ae(h.fieldPath)}}):h.aggregateType==="sum"&&u.push({alias:f,sum:{field:Ae(h.fieldPath)}})})),{request:{structuredAggregationQuery:{aggregations:u,structuredQuery:s.structuredQuery},parent:s.parent},gt:a,parent:i}}function ad(r){let t=rd(r.parent);const e=r.structuredQuery,n=e.from?e.from.length:0;let s=null;if(n>0){L(n===1,65062);const f=e.from[0];f.allDescendants?s=f.collectionId:t=t.child(f.collectionId)}let i=[];e.where&&(i=(function(m){const p=ud(m);return p instanceof tt&&ha(p)?p.getFilters():[p]})(e.where));let a=[];e.orderBy&&(a=(function(m){return m.map((p=>(function(C){return new ss(Nn(C.field),(function(D){switch(D){case"ASCENDING":return"asc";case"DESCENDING":return"desc";default:return}})(C.direction))})(p)))})(e.orderBy));let u=null;e.limit&&(u=(function(m){let p;return p=typeof m=="object"?m.value:m,ls(p)?null:p})(e.limit));let c=null;e.startAt&&(c=(function(m){const p=!!m.before,v=m.values||[];return new Ne(v,p)})(e.startAt));let h=null;return e.endAt&&(h=(function(m){const p=!m.before,v=m.values||[];return new Ne(v,p)})(e.endAt)),xh(t,s,a,i,u,"F",c,h)}function Hg(r,t){const e=(function(s){switch(s){case"TargetPurposeListen":return null;case"TargetPurposeExistenceFilterMismatch":return"existence-filter-mismatch";case"TargetPurposeExistenceFilterMismatchBloom":return"existence-filter-mismatch-bloom";case"TargetPurposeLimboResolution":return"limbo-document";default:return O(28987,{purpose:s})}})(t.purpose);return e==null?null:{"goog-listen-tags":e}}function ud(r){return r.unaryFilter!==void 0?(function(e){switch(e.unaryFilter.op){case"IS_NAN":const n=Nn(e.unaryFilter.field);return W.create(n,"==",{doubleValue:NaN});case"IS_NULL":const s=Nn(e.unaryFilter.field);return W.create(s,"==",{nullValue:"NULL_VALUE"});case"IS_NOT_NAN":const i=Nn(e.unaryFilter.field);return W.create(i,"!=",{doubleValue:NaN});case"IS_NOT_NULL":const a=Nn(e.unaryFilter.field);return W.create(a,"!=",{nullValue:"NULL_VALUE"});case"OPERATOR_UNSPECIFIED":return O(61313);default:return O(60726)}})(r):r.fieldFilter!==void 0?(function(e){return W.create(Nn(e.fieldFilter.field),(function(s){switch(s){case"EQUAL":return"==";case"NOT_EQUAL":return"!=";case"GREATER_THAN":return">";case"GREATER_THAN_OR_EQUAL":return">=";case"LESS_THAN":return"<";case"LESS_THAN_OR_EQUAL":return"<=";case"ARRAY_CONTAINS":return"array-contains";case"IN":return"in";case"NOT_IN":return"not-in";case"ARRAY_CONTAINS_ANY":return"array-contains-any";case"OPERATOR_UNSPECIFIED":return O(58110);default:return O(50506)}})(e.fieldFilter.op),e.fieldFilter.value)})(r):r.compositeFilter!==void 0?(function(e){return tt.create(e.compositeFilter.filters.map((n=>ud(n))),(function(s){switch(s){case"AND":return"and";case"OR":return"or";default:return O(1026)}})(e.compositeFilter.op))})(r):O(30097,{filter:r})}function Jg(r){return Ug[r]}function Yg(r){return jg[r]}function Xg(r){return zg[r]}function Ae(r){return{fieldPath:r.canonicalString()}}function Nn(r){return ct.fromServerFormat(r.fieldPath)}function cd(r){return r instanceof W?(function(e){if(e.op==="=="){if(vc(e.value))return{unaryFilter:{field:Ae(e.field),op:"IS_NAN"}};if(Ac(e.value))return{unaryFilter:{field:Ae(e.field),op:"IS_NULL"}}}else if(e.op==="!="){if(vc(e.value))return{unaryFilter:{field:Ae(e.field),op:"IS_NOT_NAN"}};if(Ac(e.value))return{unaryFilter:{field:Ae(e.field),op:"IS_NOT_NULL"}}}return{fieldFilter:{field:Ae(e.field),op:Yg(e.op),value:e.value}}})(r):r instanceof tt?(function(e){const n=e.getFilters().map((s=>cd(s)));return n.length===1?n[0]:{compositeFilter:{op:Xg(e.op),filters:n}}})(r):O(54877,{filter:r})}function Zg(r){const t=[];return r.fields.forEach((e=>t.push(e.canonicalString()))),{fieldPaths:t}}function ld(r){return r.length>=4&&r.get(0)==="projects"&&r.get(2)==="databases"}function hd(r){return!!r&&typeof r._toProto=="function"&&r._protoValueType==="ProtoValue"}/**
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
 */class oe{constructor(t,e,n,s,i=B.min(),a=B.min(),u=ft.EMPTY_BYTE_STRING,c=null){this.target=t,this.targetId=e,this.purpose=n,this.sequenceNumber=s,this.snapshotVersion=i,this.lastLimboFreeSnapshotVersion=a,this.resumeToken=u,this.expectedCount=c}withSequenceNumber(t){return new oe(this.target,this.targetId,this.purpose,t,this.snapshotVersion,this.lastLimboFreeSnapshotVersion,this.resumeToken,this.expectedCount)}withResumeToken(t,e){return new oe(this.target,this.targetId,this.purpose,this.sequenceNumber,e,this.lastLimboFreeSnapshotVersion,t,null)}withExpectedCount(t){return new oe(this.target,this.targetId,this.purpose,this.sequenceNumber,this.snapshotVersion,this.lastLimboFreeSnapshotVersion,this.resumeToken,t)}withLastLimboFreeSnapshotVersion(t){return new oe(this.target,this.targetId,this.purpose,this.sequenceNumber,this.snapshotVersion,t,this.resumeToken,this.expectedCount)}}/**
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
 */class dd{constructor(t){this.yt=t}}function tp(r,t){let e;if(t.document)e=Ci(r.yt,t.document,!!t.hasCommittedMutations);else if(t.noDocument){const n=k.fromSegments(t.noDocument.path),s=fn(t.noDocument.readTime);e=at.newNoDocument(n,s),t.hasCommittedMutations&&e.setHasCommittedMutations()}else{if(!t.unknownDocument)return O(56709);{const n=k.fromSegments(t.unknownDocument.path),s=fn(t.unknownDocument.version);e=at.newUnknownDocument(n,s)}}return t.readTime&&e.setReadTime((function(s){const i=new Z(s[0],s[1]);return B.fromTimestamp(i)})(t.readTime)),e}function Uc(r,t){const e=t.key,n={prefixPath:e.getCollectionPath().popLast().toArray(),collectionGroup:e.collectionGroup,documentId:e.path.lastSegment(),readTime:hi(t.readTime),hasCommittedMutations:t.hasCommittedMutations};if(t.isFoundDocument())n.document=(function(i,a){return{name:is(i,a.key),fields:a.data.value.mapValue.fields,updateTime:Yn(i,a.version.toTimestamp()),createTime:Yn(i,a.createTime.toTimestamp())}})(r.yt,t);else if(t.isNoDocument())n.noDocument={path:e.path.toArray(),readTime:dn(t.version)};else{if(!t.isUnknownDocument())return O(57904,{document:t});n.unknownDocument={path:e.path.toArray(),version:dn(t.version)}}return n}function hi(r){const t=r.toTimestamp();return[t.seconds,t.nanoseconds]}function dn(r){const t=r.toTimestamp();return{seconds:t.seconds,nanoseconds:t.nanoseconds}}function fn(r){const t=new Z(r.seconds,r.nanoseconds);return B.fromTimestamp(t)}function Ze(r,t){const e=(t.baseMutations||[]).map((i=>Go(r.yt,i)));for(let i=0;i<t.mutations.length-1;++i){const a=t.mutations[i];if(i+1<t.mutations.length&&t.mutations[i+1].transform!==void 0){const u=t.mutations[i+1];a.updateTransforms=u.transform.fieldTransforms,t.mutations.splice(i+1,1),++i}}const n=t.mutations.map((i=>Go(r.yt,i))),s=Z.fromMillis(t.localWriteTimeMs);return new pa(t.batchId,s,e,n)}function Br(r){const t=fn(r.readTime),e=r.lastLimboFreeSnapshotVersion!==void 0?fn(r.lastLimboFreeSnapshotVersion):B.min();let n;return n=(function(i){return i.documents!==void 0})(r.query)?(function(i){const a=i.documents.length;return L(a===1,1966,{count:a}),Dt(ir(rd(i.documents[0])))})(r.query):(function(i){return Dt(ad(i))})(r.query),new oe(n,r.targetId,"TargetPurposeListen",r.lastListenSequenceNumber,t,e,ft.fromBase64String(r.resumeToken))}function fd(r,t){const e=dn(t.snapshotVersion),n=dn(t.lastLimboFreeSnapshotVersion);let s;s=ui(t.target)?id(r.yt,t.target):xi(r.yt,t.target).ft;const i=t.resumeToken.toBase64();return{targetId:t.targetId,canonicalId:cn(t.target),readTime:e,resumeToken:i,lastListenSequenceNumber:t.sequenceNumber,lastLimboFreeSnapshotVersion:n,query:s}}function Di(r){const t=ad({parent:r.parent,structuredQuery:r.structuredQuery});return r.limitType==="LAST"?li(t,t.limit,"L"):t}function yo(r,t){return new ya(t.largestBatchId,Go(r.yt,t.overlayMutation))}function jc(r,t){const e=t.path.lastSegment();return[r,xt(t.path.popLast()),e]}function zc(r,t,e,n){return{indexId:r,uid:t,sequenceNumber:e,readTime:dn(n.readTime),documentKey:xt(n.documentKey.path),largestBatchId:n.largestBatchId}}/**
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
 */class ep{getBundleMetadata(t,e){return Gc(t).get(e).next((n=>{if(n)return(function(i){return{id:i.bundleId,createTime:fn(i.createTime),version:i.version}})(n)}))}saveBundleMetadata(t,e){return Gc(t).put((function(s){return{bundleId:s.id,createTime:dn(gt(s.createTime)),version:s.version}})(e))}getNamedQuery(t,e){return Kc(t).get(e).next((n=>{if(n)return(function(i){return{name:i.name,query:Di(i.bundledQuery),readTime:fn(i.readTime)}})(n)}))}saveNamedQuery(t,e){return Kc(t).put((function(s){return{name:s.name,readTime:dn(gt(s.readTime)),bundledQuery:s.bundledQuery}})(e))}}function Gc(r){return Tt(r,wi)}function Kc(r){return Tt(r,Ai)}/**
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
 */class Ni{constructor(t,e){this.serializer=t,this.userId=e}static wt(t,e){const n=e.uid||"";return new Ni(t,n)}getOverlay(t,e){return xr(t).get(jc(this.userId,e)).next((n=>n?yo(this.serializer,n):null))}getOverlays(t,e){const n=Zt();return A.forEach(e,(s=>this.getOverlay(t,s).next((i=>{i!==null&&n.set(s,i)})))).next((()=>n))}saveOverlays(t,e,n){const s=[];return n.forEach(((i,a)=>{const u=new ya(e,a);s.push(this.bt(t,u))})),A.waitFor(s)}removeOverlaysForBatchId(t,e,n){const s=new Set;e.forEach((a=>s.add(xt(a.getCollectionPath()))));const i=[];return s.forEach((a=>{const u=IDBKeyRange.bound([this.userId,a,n],[this.userId,a,n+1],!1,!0);i.push(xr(t).X(No,u))})),A.waitFor(i)}getOverlaysForCollection(t,e,n){const s=Zt(),i=xt(e),a=IDBKeyRange.bound([this.userId,i,n],[this.userId,i,Number.POSITIVE_INFINITY],!0);return xr(t).H(No,a).next((u=>{for(const c of u){const h=yo(this.serializer,c);s.set(h.getKey(),h)}return s}))}getOverlaysForCollectionGroup(t,e,n,s){const i=Zt();let a;const u=IDBKeyRange.bound([this.userId,e,n],[this.userId,e,Number.POSITIVE_INFINITY],!0);return xr(t).ee({index:uh,range:u},((c,h,f)=>{const m=yo(this.serializer,h);i.size()<s||m.largestBatchId===a?(i.set(m.getKey(),m),a=m.largestBatchId):f.done()})).next((()=>i))}bt(t,e){return xr(t).put((function(s,i,a){const[u,c,h]=jc(i,a.mutation.key);return{userId:i,collectionPath:c,documentId:h,collectionGroup:a.mutation.key.getCollectionGroup(),largestBatchId:a.largestBatchId,overlayMutation:os(s.yt,a.mutation)}})(this.serializer,this.userId,e))}}function xr(r){return Tt(r,vi)}/**
 * @license
 * Copyright 2024 Google LLC
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
 */class np{St(t){return Tt(t,aa)}getSessionToken(t){return this.St(t).get("sessionToken").next((e=>{const n=e==null?void 0:e.value;return n?ft.fromUint8Array(n):ft.EMPTY_BYTE_STRING}))}setSessionToken(t,e){return this.St(t).put({name:"sessionToken",value:e.toUint8Array()})}}/**
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
 */class tn{constructor(){}Dt(t,e){this.Ct(t,e),e.vt()}Ct(t,e){if("nullValue"in t)this.Ft(e,5);else if("booleanValue"in t)this.Ft(e,10),e.Mt(t.booleanValue?1:0);else if("integerValue"in t)this.Ft(e,15),e.Mt(ut(t.integerValue));else if("doubleValue"in t){const n=ut(t.doubleValue);isNaN(n)?this.Ft(e,13):(this.Ft(e,15),Jr(n)?e.Mt(0):e.Mt(n))}else if("timestampValue"in t){let n=t.timestampValue;this.Ft(e,20),typeof n=="string"&&(n=ae(n)),e.xt(`${n.seconds||""}`),e.Mt(n.nanos||0)}else if("stringValue"in t)this.Ot(t.stringValue,e),this.Nt(e);else if("bytesValue"in t)this.Ft(e,30),e.Bt(ue(t.bytesValue)),this.Nt(e);else if("referenceValue"in t)this.Lt(t.referenceValue,e);else if("geoPointValue"in t){const n=t.geoPointValue;this.Ft(e,45),e.Mt(n.latitude||0),e.Mt(n.longitude||0)}else"mapValue"in t?Eh(t)?this.Ft(e,Number.MAX_SAFE_INTEGER):Si(t)?this.kt(t.mapValue,e):(this.Kt(t.mapValue,e),this.Nt(e)):"arrayValue"in t?(this.qt(t.arrayValue,e),this.Nt(e)):O(19022,{Ut:t})}Ot(t,e){this.Ft(e,25),this.$t(t,e)}$t(t,e){e.xt(t)}Kt(t,e){const n=t.fields||{};this.Ft(e,55);for(const s of Object.keys(n))this.Ot(s,e),this.Ct(n[s],e)}kt(t,e){var a,u;const n=t.fields||{};this.Ft(e,53);const s=$n,i=((u=(a=n[s].arrayValue)==null?void 0:a.values)==null?void 0:u.length)||0;this.Ft(e,15),e.Mt(ut(i)),this.Ot(s,e),this.Ct(n[s],e)}qt(t,e){const n=t.values||[];this.Ft(e,50);for(const s of n)this.Ct(s,e)}Lt(t,e){this.Ft(e,37),k.fromName(t).path.forEach((n=>{this.Ft(e,60),this.$t(n,e)}))}Ft(t,e){t.Mt(e)}Nt(t){t.Mt(2)}}tn.Wt=new tn;/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law | agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES | CONDITIONS OF ANY KIND, either express | implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */const Sn=255;function rp(r){if(r===0)return 8;let t=0;return r>>4||(t+=4,r<<=4),r>>6||(t+=2,r<<=2),r>>7||(t+=1),t}function $c(r){const t=64-(function(n){let s=0;for(let i=0;i<8;++i){const a=rp(255&n[i]);if(s+=a,a!==8)break}return s})(r);return Math.ceil(t/8)}class sp{constructor(){this.buffer=new Uint8Array(1024),this.position=0}Qt(t){const e=t[Symbol.iterator]();let n=e.next();for(;!n.done;)this.Gt(n.value),n=e.next();this.zt()}jt(t){const e=t[Symbol.iterator]();let n=e.next();for(;!n.done;)this.Ht(n.value),n=e.next();this.Jt()}Zt(t){for(const e of t){const n=e.charCodeAt(0);if(n<128)this.Gt(n);else if(n<2048)this.Gt(960|n>>>6),this.Gt(128|63&n);else if(e<"\uD800"||"\uDBFF"<e)this.Gt(480|n>>>12),this.Gt(128|63&n>>>6),this.Gt(128|63&n);else{const s=e.codePointAt(0);this.Gt(240|s>>>18),this.Gt(128|63&s>>>12),this.Gt(128|63&s>>>6),this.Gt(128|63&s)}}this.zt()}Xt(t){for(const e of t){const n=e.charCodeAt(0);if(n<128)this.Ht(n);else if(n<2048)this.Ht(960|n>>>6),this.Ht(128|63&n);else if(e<"\uD800"||"\uDBFF"<e)this.Ht(480|n>>>12),this.Ht(128|63&n>>>6),this.Ht(128|63&n);else{const s=e.codePointAt(0);this.Ht(240|s>>>18),this.Ht(128|63&s>>>12),this.Ht(128|63&s>>>6),this.Ht(128|63&s)}}this.Jt()}Yt(t){const e=this.en(t),n=$c(e);this.tn(1+n),this.buffer[this.position++]=255&n;for(let s=e.length-n;s<e.length;++s)this.buffer[this.position++]=255&e[s]}nn(t){const e=this.en(t),n=$c(e);this.tn(1+n),this.buffer[this.position++]=~(255&n);for(let s=e.length-n;s<e.length;++s)this.buffer[this.position++]=~(255&e[s])}rn(){this.sn(Sn),this.sn(255)}_n(){this.an(Sn),this.an(255)}reset(){this.position=0}seed(t){this.tn(t.length),this.buffer.set(t,this.position),this.position+=t.length}un(){return this.buffer.slice(0,this.position)}en(t){const e=(function(i){const a=new DataView(new ArrayBuffer(8));return a.setFloat64(0,i,!1),new Uint8Array(a.buffer)})(t),n=!!(128&e[0]);e[0]^=n?255:128;for(let s=1;s<e.length;++s)e[s]^=n?255:0;return e}Gt(t){const e=255&t;e===0?(this.sn(0),this.sn(255)):e===Sn?(this.sn(Sn),this.sn(0)):this.sn(e)}Ht(t){const e=255&t;e===0?(this.an(0),this.an(255)):e===Sn?(this.an(Sn),this.an(0)):this.an(t)}zt(){this.sn(0),this.sn(1)}Jt(){this.an(0),this.an(1)}sn(t){this.tn(1),this.buffer[this.position++]=t}an(t){this.tn(1),this.buffer[this.position++]=~t}tn(t){const e=t+this.position;if(e<=this.buffer.length)return;let n=2*this.buffer.length;n<e&&(n=e);const s=new Uint8Array(n);s.set(this.buffer),this.buffer=s}}class ip{constructor(t){this.cn=t}Bt(t){this.cn.Qt(t)}xt(t){this.cn.Zt(t)}Mt(t){this.cn.Yt(t)}vt(){this.cn.rn()}}class op{constructor(t){this.cn=t}Bt(t){this.cn.jt(t)}xt(t){this.cn.Xt(t)}Mt(t){this.cn.nn(t)}vt(){this.cn._n()}}class Dr{constructor(){this.cn=new sp,this.ascending=new ip(this.cn),this.descending=new op(this.cn)}seed(t){this.cn.seed(t)}ln(t){return t===0?this.ascending:this.descending}un(){return this.cn.un()}reset(){this.cn.reset()}}/**
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
 */class en{constructor(t,e,n,s){this.hn=t,this.Pn=e,this.Tn=n,this.In=s}En(){const t=this.In.length,e=t===0||this.In[t-1]===255?t+1:t,n=new Uint8Array(e);return n.set(this.In,0),e!==t?n.set([0],this.In.length):++n[n.length-1],new en(this.hn,this.Pn,this.Tn,n)}Rn(t,e,n){return{indexId:this.hn,uid:t,arrayValue:ei(this.Tn),directionalValue:ei(this.In),orderedDocumentKey:ei(e),documentKey:n.path.toArray()}}An(t,e,n){const s=this.Rn(t,e,n);return[s.indexId,s.uid,s.arrayValue,s.directionalValue,s.orderedDocumentKey,s.documentKey]}}function Te(r,t){let e=r.hn-t.hn;return e!==0?e:(e=Qc(r.Tn,t.Tn),e!==0?e:(e=Qc(r.In,t.In),e!==0?e:k.comparator(r.Pn,t.Pn)))}function Qc(r,t){for(let e=0;e<r.length&&e<t.length;++e){const n=r[e]-t[e];if(n!==0)return n}return r.length-t.length}function ei(r){return ql()?(function(e){let n="";for(let s=0;s<e.length;s++)n+=String.fromCharCode(e[s]);return n})(r):r}function Wc(r){return typeof r!="string"?r:(function(e){const n=new Uint8Array(e.length);for(let s=0;s<e.length;s++)n[s]=e.charCodeAt(s);return n})(r)}class Hc{constructor(t){this.Vn=new et(((e,n)=>ct.comparator(e.field,n.field))),this.collectionId=t.collectionGroup!=null?t.collectionGroup:t.path.lastSegment(),this.dn=t.orderBy,this.mn=[];for(const e of t.filters){const n=e;n.isInequality()?this.Vn=this.Vn.add(n):this.mn.push(n)}}get fn(){return this.Vn.size>1}gn(t){if(L(t.collectionGroup===this.collectionId,49279),this.fn)return!1;const e=Co(t);if(e!==void 0&&!this.pn(e))return!1;const n=Je(t);let s=new Set,i=0,a=0;for(;i<n.length&&this.pn(n[i]);++i)s=s.add(n[i].fieldPath.canonicalString());if(i===n.length)return!0;if(this.Vn.size>0){const u=this.Vn.getIterator().getNext();if(!s.has(u.field.canonicalString())){const c=n[i];if(!this.yn(u,c)||!this.wn(this.dn[a++],c))return!1}++i}for(;i<n.length;++i){const u=n[i];if(a>=this.dn.length||!this.wn(this.dn[a++],u))return!1}return!0}bn(){if(this.fn)return null;let t=new et(ct.comparator);const e=[];for(const n of this.mn)if(!n.field.isKeyField())if(n.op==="array-contains"||n.op==="array-contains-any")e.push(new rn(n.field,2));else{if(t.has(n.field))continue;t=t.add(n.field),e.push(new rn(n.field,0))}for(const n of this.dn)n.field.isKeyField()||t.has(n.field)||(t=t.add(n.field),e.push(new rn(n.field,n.dir==="asc"?0:1)));return new Bn(Bn.UNKNOWN_ID,this.collectionId,e,Un.empty())}pn(t){for(const e of this.mn)if(this.yn(e,t))return!0;return!1}yn(t,e){if(t===void 0||!t.field.isEqual(e.fieldPath))return!1;const n=t.op==="array-contains"||t.op==="array-contains-any";return e.kind===2===n}wn(t,e){return!!t.field.isEqual(e.fieldPath)&&(e.kind===0&&t.dir==="asc"||e.kind===1&&t.dir==="desc")}}/**
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
 */function md(r){var e,n;if(L(r instanceof W||r instanceof tt,20012),r instanceof W){if(r instanceof Ch){const s=((n=(e=r.value.arrayValue)==null?void 0:e.values)==null?void 0:n.map((i=>W.create(r.field,"==",i))))||[];return tt.create(s,"or")}return r}const t=r.filters.map((s=>md(s)));return tt.create(t,r.op)}function ap(r){if(r.getFilters().length===0)return[];const t=Qo(md(r));return L(gd(t),7391),Ko(t)||$o(t)?[t]:t.getFilters()}function Ko(r){return r instanceof W}function $o(r){return r instanceof tt&&ha(r)}function gd(r){return Ko(r)||$o(r)||(function(e){if(e instanceof tt&&Oo(e)){for(const n of e.getFilters())if(!Ko(n)&&!$o(n))return!1;return!0}return!1})(r)}function Qo(r){if(L(r instanceof W||r instanceof tt,34018),r instanceof W)return r;if(r.filters.length===1)return Qo(r.filters[0]);const t=r.filters.map((n=>Qo(n)));let e=tt.create(t,r.op);return e=di(e),gd(e)?e:(L(e instanceof tt,64498),L(Wn(e),40251),L(e.filters.length>1,57927),e.filters.reduce(((n,s)=>Ea(n,s))))}function Ea(r,t){let e;return L(r instanceof W||r instanceof tt,38388),L(t instanceof W||t instanceof tt,25473),e=r instanceof W?t instanceof W?(function(s,i){return tt.create([s,i],"and")})(r,t):Jc(r,t):t instanceof W?Jc(t,r):(function(s,i){if(L(s.filters.length>0&&i.filters.length>0,48005),Wn(s)&&Wn(i))return Sh(s,i.getFilters());const a=Oo(s)?s:i,u=Oo(s)?i:s,c=a.filters.map((h=>Ea(h,u)));return tt.create(c,"or")})(r,t),di(e)}function Jc(r,t){if(Wn(t))return Sh(t,r.getFilters());{const e=t.filters.map((n=>Ea(r,n)));return tt.create(e,"or")}}function di(r){if(L(r instanceof W||r instanceof tt,11850),r instanceof W)return r;const t=r.getFilters();if(t.length===1)return di(t[0]);if(Rh(r))return r;const e=t.map((s=>di(s))),n=[];return e.forEach((s=>{s instanceof W?n.push(s):s instanceof tt&&(s.op===r.op?n.push(...s.filters):n.push(s))})),n.length===1?n[0]:tt.create(n,r.op)}/**
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
 */class up{constructor(){this.Sn=new wa}addToCollectionParentIndex(t,e){return this.Sn.add(e),A.resolve()}getCollectionParents(t,e){return A.resolve(this.Sn.getEntries(e))}addFieldIndex(t,e){return A.resolve()}deleteFieldIndex(t,e){return A.resolve()}deleteAllFieldIndexes(t){return A.resolve()}createTargetIndexes(t,e){return A.resolve()}getDocumentsMatchingTarget(t,e){return A.resolve(null)}getIndexType(t,e){return A.resolve(0)}getFieldIndexes(t,e){return A.resolve([])}getNextCollectionGroupToUpdate(t){return A.resolve(null)}getMinOffset(t,e){return A.resolve(Kt.min())}getMinOffsetFromCollectionGroup(t,e){return A.resolve(Kt.min())}updateCollectionGroup(t,e,n){return A.resolve()}updateIndexEntries(t,e){return A.resolve()}}class wa{constructor(){this.index={}}add(t){const e=t.lastSegment(),n=t.popLast(),s=this.index[e]||new et($.comparator),i=!s.has(n);return this.index[e]=s.add(n),i}has(t){const e=t.lastSegment(),n=t.popLast(),s=this.index[e];return s&&s.has(n)}getEntries(t){return(this.index[t]||new et($.comparator)).toArray()}}/**
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
 */const Yc="IndexedDbIndexManager",js=new Uint8Array(0);class cp{constructor(t,e){this.databaseId=e,this.Dn=new wa,this.Cn=new he((n=>cn(n)),((n,s)=>ds(n,s))),this.uid=t.uid||""}addToCollectionParentIndex(t,e){if(!this.Dn.has(e)){const n=e.lastSegment(),s=e.popLast();t.addOnCommittedListener((()=>{this.Dn.add(e)}));const i={collectionId:n,parent:xt(s)};return Xc(t).put(i)}return A.resolve()}getCollectionParents(t,e){const n=[],s=IDBKeyRange.bound([e,""],[Wl(e),""],!1,!0);return Xc(t).H(s).next((i=>{for(const a of i){if(a.collectionId!==e)break;n.push(Xt(a.parent))}return n}))}addFieldIndex(t,e){const n=Nr(t),s=(function(u){return{indexId:u.indexId,collectionGroup:u.collectionGroup,fields:u.fields.map((c=>[c.fieldPath.canonicalString(),c.kind]))}})(e);delete s.indexId;const i=n.add(s);if(e.indexState){const a=bn(t);return i.next((u=>{a.put(zc(u,this.uid,e.indexState.sequenceNumber,e.indexState.offset))}))}return i.next()}deleteFieldIndex(t,e){const n=Nr(t),s=bn(t),i=Vn(t);return n.delete(e.indexId).next((()=>s.delete(IDBKeyRange.bound([e.indexId],[e.indexId+1],!1,!0)))).next((()=>i.delete(IDBKeyRange.bound([e.indexId],[e.indexId+1],!1,!0))))}deleteAllFieldIndexes(t){const e=Nr(t),n=Vn(t),s=bn(t);return e.X().next((()=>n.X())).next((()=>s.X()))}createTargetIndexes(t,e){return A.forEach(this.vn(e),(n=>this.getIndexType(t,n).next((s=>{if(s===0||s===1){const i=new Hc(n).bn();if(i!=null)return this.addFieldIndex(t,i)}}))))}getDocumentsMatchingTarget(t,e){const n=Vn(t);let s=!0;const i=new Map;return A.forEach(this.vn(e),(a=>this.Fn(t,a).next((u=>{s&&(s=!!u),i.set(a,u)})))).next((()=>{if(s){let a=G();const u=[];return A.forEach(i,((c,h)=>{x(Yc,`Using index ${(function(U){return`id=${U.indexId}|cg=${U.collectionGroup}|f=${U.fields.map((X=>`${X.fieldPath}:${X.kind}`)).join(",")}`})(c)} to execute ${cn(e)}`);const f=(function(U,X){const J=Co(X);if(J===void 0)return null;for(const Y of ci(U,J.fieldPath))switch(Y.op){case"array-contains-any":return Y.value.arrayValue.values||[];case"array-contains":return[Y.value]}return null})(h,c),m=(function(U,X){const J=new Map;for(const Y of Je(X))for(const T of ci(U,Y.fieldPath))switch(T.op){case"==":case"in":J.set(Y.fieldPath.canonicalString(),T.value);break;case"not-in":case"!=":return J.set(Y.fieldPath.canonicalString(),T.value),Array.from(J.values())}return null})(h,c),p=(function(U,X){const J=[];let Y=!0;for(const T of Je(X)){const _=T.kind===0?bc(U,T.fieldPath,U.startAt):Cc(U,T.fieldPath,U.startAt);J.push(_.value),Y&&(Y=_.inclusive)}return new Ne(J,Y)})(h,c),v=(function(U,X){const J=[];let Y=!0;for(const T of Je(X)){const _=T.kind===0?Cc(U,T.fieldPath,U.endAt):bc(U,T.fieldPath,U.endAt);J.push(_.value),Y&&(Y=_.inclusive)}return new Ne(J,Y)})(h,c),C=this.Mn(c,h,p),N=this.Mn(c,h,v),D=this.xn(c,h,m),q=this.On(c.indexId,f,C,p.inclusive,N,v.inclusive,D);return A.forEach(q,(j=>n.Z(j,e.limit).next((U=>{U.forEach((X=>{const J=k.fromSegments(X.documentKey);a.has(J)||(a=a.add(J),u.push(J))}))}))))})).next((()=>u))}return A.resolve(null)}))}vn(t){let e=this.Cn.get(t);return e||(t.filters.length===0?e=[t]:e=ap(tt.create(t.filters,"and")).map((n=>qo(t.path,t.collectionGroup,t.orderBy,n.getFilters(),t.limit,t.startAt,t.endAt))),this.Cn.set(t,e),e)}On(t,e,n,s,i,a,u){const c=(e!=null?e.length:1)*Math.max(n.length,i.length),h=c/(e!=null?e.length:1),f=[];for(let m=0;m<c;++m){const p=e?this.Nn(e[m/h]):js,v=this.Bn(t,p,n[m%h],s),C=this.Ln(t,p,i[m%h],a),N=u.map((D=>this.Bn(t,p,D,!0)));f.push(...this.createRange(v,C,N))}return f}Bn(t,e,n,s){const i=new en(t,k.empty(),e,n);return s?i:i.En()}Ln(t,e,n,s){const i=new en(t,k.empty(),e,n);return s?i.En():i}Fn(t,e){const n=new Hc(e),s=e.collectionGroup!=null?e.collectionGroup:e.path.lastSegment();return this.getFieldIndexes(t,s).next((i=>{let a=null;for(const u of i)n.gn(u)&&(!a||u.fields.length>a.fields.length)&&(a=u);return a}))}getIndexType(t,e){let n=2;const s=this.vn(e);return A.forEach(s,(i=>this.Fn(t,i).next((a=>{a?n!==0&&a.fields.length<(function(c){let h=new et(ct.comparator),f=!1;for(const m of c.filters)for(const p of m.getFlattenedFilters())p.field.isKeyField()||(p.op==="array-contains"||p.op==="array-contains-any"?f=!0:h=h.add(p.field));for(const m of c.orderBy)m.field.isKeyField()||(h=h.add(m.field));return h.size+(f?1:0)})(i)&&(n=1):n=0})))).next((()=>(function(a){return a.limit!==null})(e)&&s.length>1&&n===2?1:n))}kn(t,e){const n=new Dr;for(const s of Je(t)){const i=e.data.field(s.fieldPath);if(i==null)return null;const a=n.ln(s.kind);tn.Wt.Dt(i,a)}return n.un()}Nn(t){const e=new Dr;return tn.Wt.Dt(t,e.ln(0)),e.un()}Kn(t,e){const n=new Dr;return tn.Wt.Dt(un(this.databaseId,e),n.ln((function(i){const a=Je(i);return a.length===0?0:a[a.length-1].kind})(t))),n.un()}xn(t,e,n){if(n===null)return[];let s=[];s.push(new Dr);let i=0;for(const a of Je(t)){const u=n[i++];for(const c of s)if(this.qn(e,a.fieldPath)&&rs(u))s=this.Un(s,a,u);else{const h=c.ln(a.kind);tn.Wt.Dt(u,h)}}return this.$n(s)}Mn(t,e,n){return this.xn(t,e,n.position)}$n(t){const e=[];for(let n=0;n<t.length;++n)e[n]=t[n].un();return e}Un(t,e,n){const s=[...t],i=[];for(const a of n.arrayValue.values||[])for(const u of s){const c=new Dr;c.seed(u.un()),tn.Wt.Dt(a,c.ln(e.kind)),i.push(c)}return i}qn(t,e){return!!t.filters.find((n=>n instanceof W&&n.field.isEqual(e)&&(n.op==="in"||n.op==="not-in")))}getFieldIndexes(t,e){const n=Nr(t),s=bn(t);return(e?n.H(Do,IDBKeyRange.bound(e,e)):n.H()).next((i=>{const a=[];return A.forEach(i,(u=>s.get([u.indexId,this.uid]).next((c=>{a.push((function(f,m){const p=m?new Un(m.sequenceNumber,new Kt(fn(m.readTime),new k(Xt(m.documentKey)),m.largestBatchId)):Un.empty(),v=f.fields.map((([C,N])=>new rn(ct.fromServerFormat(C),N)));return new Bn(f.indexId,f.collectionGroup,v,p)})(u,c))})))).next((()=>a))}))}getNextCollectionGroupToUpdate(t){return this.getFieldIndexes(t).next((e=>e.length===0?null:(e.sort(((n,s)=>{const i=n.indexState.sequenceNumber-s.indexState.sequenceNumber;return i!==0?i:z(n.collectionGroup,s.collectionGroup)})),e[0].collectionGroup)))}updateCollectionGroup(t,e,n){const s=Nr(t),i=bn(t);return this.Wn(t).next((a=>s.H(Do,IDBKeyRange.bound(e,e)).next((u=>A.forEach(u,(c=>i.put(zc(c.indexId,this.uid,a,n))))))))}updateIndexEntries(t,e){const n=new Map;return A.forEach(e,((s,i)=>{const a=n.get(s.collectionGroup);return(a?A.resolve(a):this.getFieldIndexes(t,s.collectionGroup)).next((u=>(n.set(s.collectionGroup,u),A.forEach(u,(c=>this.Qn(t,s,c).next((h=>{const f=this.Gn(i,c);return h.isEqual(f)?A.resolve():this.zn(t,i,c,h,f)})))))))}))}jn(t,e,n,s){return Vn(t).put(s.Rn(this.uid,this.Kn(n,e.key),e.key))}Hn(t,e,n,s){return Vn(t).delete(s.An(this.uid,this.Kn(n,e.key),e.key))}Qn(t,e,n){const s=Vn(t);let i=new et(Te);return s.ee({index:ah,range:IDBKeyRange.only([n.indexId,this.uid,ei(this.Kn(n,e))])},((a,u)=>{i=i.add(new en(n.indexId,e,Wc(u.arrayValue),Wc(u.directionalValue)))})).next((()=>i))}Gn(t,e){let n=new et(Te);const s=this.kn(e,t);if(s==null)return n;const i=Co(e);if(i!=null){const a=t.data.field(i.fieldPath);if(rs(a))for(const u of a.arrayValue.values||[])n=n.add(new en(e.indexId,t.key,this.Nn(u),s))}else n=n.add(new en(e.indexId,t.key,js,s));return n}zn(t,e,n,s,i){x(Yc,"Updating index entries for document '%s'",e.key);const a=[];return(function(c,h,f,m,p){const v=c.getIterator(),C=h.getIterator();let N=Pn(v),D=Pn(C);for(;N||D;){let q=!1,j=!1;if(N&&D){const U=f(N,D);U<0?j=!0:U>0&&(q=!0)}else N!=null?j=!0:q=!0;q?(m(D),D=Pn(C)):j?(p(N),N=Pn(v)):(N=Pn(v),D=Pn(C))}})(s,i,Te,(u=>{a.push(this.jn(t,e,n,u))}),(u=>{a.push(this.Hn(t,e,n,u))})),A.waitFor(a)}Wn(t){let e=1;return bn(t).ee({index:oh,reverse:!0,range:IDBKeyRange.upperBound([this.uid,Number.MAX_SAFE_INTEGER])},((n,s,i)=>{i.done(),e=s.sequenceNumber+1})).next((()=>e))}createRange(t,e,n){n=n.sort(((a,u)=>Te(a,u))).filter(((a,u,c)=>!u||Te(a,c[u-1])!==0));const s=[];s.push(t);for(const a of n){const u=Te(a,t),c=Te(a,e);if(u===0)s[0]=t.En();else if(u>0&&c<0)s.push(a),s.push(a.En());else if(c>0)break}s.push(e);const i=[];for(let a=0;a<s.length;a+=2){if(this.Jn(s[a],s[a+1]))return[];const u=s[a].An(this.uid,js,k.empty()),c=s[a+1].An(this.uid,js,k.empty());i.push(IDBKeyRange.bound(u,c))}return i}Jn(t,e){return Te(t,e)>0}getMinOffsetFromCollectionGroup(t,e){return this.getFieldIndexes(t,e).next(Zc)}getMinOffset(t,e){return A.mapArray(this.vn(e),(n=>this.Fn(t,n).next((s=>s||O(44426))))).next(Zc)}}function Xc(r){return Tt(r,Zr)}function Vn(r){return Tt(r,Gr)}function Nr(r){return Tt(r,oa)}function bn(r){return Tt(r,zr)}function Zc(r){L(r.length!==0,28825);let t=r[0].indexState.offset,e=t.largestBatchId;for(let n=1;n<r.length;n++){const s=r[n].indexState.offset;ra(s,t)<0&&(t=s),e<s.largestBatchId&&(e=s.largestBatchId)}return new Kt(t.readTime,t.documentKey,e)}/**
 * @license
 * Copyright 2018 Google LLC
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
 */const tl={didRun:!1,sequenceNumbersCollected:0,targetsRemoved:0,documentsRemoved:0},pd=41943040;class Ct{static withCacheSize(t){return new Ct(t,Ct.DEFAULT_COLLECTION_PERCENTILE,Ct.DEFAULT_MAX_SEQUENCE_NUMBERS_TO_COLLECT)}constructor(t,e,n){this.cacheSizeCollectionThreshold=t,this.percentileToCollect=e,this.maximumSequenceNumbersToCollect=n}}/**
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
 */function _d(r,t,e){const n=r.store(Qt),s=r.store(jn),i=[],a=IDBKeyRange.only(e.batchId);let u=0;const c=n.ee({range:a},((f,m,p)=>(u++,p.delete())));i.push(c.next((()=>{L(u===1,47070,{batchId:e.batchId})})));const h=[];for(const f of e.mutations){const m=rh(t,f.key.path,e.batchId);i.push(s.delete(m)),h.push(f.key)}return A.waitFor(i).next((()=>h))}function fi(r){if(!r)return 0;let t;if(r.document)t=r.document;else if(r.unknownDocument)t=r.unknownDocument;else{if(!r.noDocument)throw O(14731);t=r.noDocument}return JSON.stringify(t).length}/**
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
 */Ct.DEFAULT_COLLECTION_PERCENTILE=10,Ct.DEFAULT_MAX_SEQUENCE_NUMBERS_TO_COLLECT=1e3,Ct.DEFAULT=new Ct(pd,Ct.DEFAULT_COLLECTION_PERCENTILE,Ct.DEFAULT_MAX_SEQUENCE_NUMBERS_TO_COLLECT),Ct.DISABLED=new Ct(-1,0,0);class ki{constructor(t,e,n,s){this.userId=t,this.serializer=e,this.indexManager=n,this.referenceDelegate=s,this.Zn={}}static wt(t,e,n,s){L(t.uid!=="",64387);const i=t.isAuthenticated()?t.uid:"";return new ki(i,e,n,s)}checkEmpty(t){let e=!0;const n=IDBKeyRange.bound([this.userId,Number.NEGATIVE_INFINITY],[this.userId,Number.POSITIVE_INFINITY]);return Ee(t).ee({index:nn,range:n},((s,i,a)=>{e=!1,a.done()})).next((()=>e))}addMutationBatch(t,e,n,s){const i=kn(t),a=Ee(t);return a.add({}).next((u=>{L(typeof u=="number",49019);const c=new pa(u,e,n,s),h=(function(v,C,N){const D=N.baseMutations.map((j=>os(v.yt,j))),q=N.mutations.map((j=>os(v.yt,j)));return{userId:C,batchId:N.batchId,localWriteTimeMs:N.localWriteTime.toMillis(),baseMutations:D,mutations:q}})(this.serializer,this.userId,c),f=[];let m=new et(((p,v)=>z(p.canonicalString(),v.canonicalString())));for(const p of s){const v=rh(this.userId,p.key.path,u);m=m.add(p.key.path.popLast()),f.push(a.put(h)),f.push(i.put(v,qm))}return m.forEach((p=>{f.push(this.indexManager.addToCollectionParentIndex(t,p))})),t.addOnCommittedListener((()=>{this.Zn[u]=c.keys()})),A.waitFor(f).next((()=>c))}))}lookupMutationBatch(t,e){return Ee(t).get(e).next((n=>n?(L(n.userId===this.userId,48,"Unexpected user for mutation batch",{userId:n.userId,batchId:e}),Ze(this.serializer,n)):null))}Xn(t,e){return this.Zn[e]?A.resolve(this.Zn[e]):this.lookupMutationBatch(t,e).next((n=>{if(n){const s=n.keys();return this.Zn[e]=s,s}return null}))}getNextMutationBatchAfterBatchId(t,e){const n=e+1,s=IDBKeyRange.lowerBound([this.userId,n]);let i=null;return Ee(t).ee({index:nn,range:s},((a,u,c)=>{u.userId===this.userId&&(L(u.batchId>=n,47524,{Yn:n}),i=Ze(this.serializer,u)),c.done()})).next((()=>i))}getHighestUnacknowledgedBatchId(t){const e=IDBKeyRange.upperBound([this.userId,Number.POSITIVE_INFINITY]);let n=be;return Ee(t).ee({index:nn,range:e,reverse:!0},((s,i,a)=>{n=i.batchId,a.done()})).next((()=>n))}getAllMutationBatches(t){const e=IDBKeyRange.bound([this.userId,be],[this.userId,Number.POSITIVE_INFINITY]);return Ee(t).H(nn,e).next((n=>n.map((s=>Ze(this.serializer,s)))))}getAllMutationBatchesAffectingDocumentKey(t,e){const n=Ws(this.userId,e.path),s=IDBKeyRange.lowerBound(n),i=[];return kn(t).ee({range:s},((a,u,c)=>{const[h,f,m]=a,p=Xt(f);if(h===this.userId&&e.path.isEqual(p))return Ee(t).get(m).next((v=>{if(!v)throw O(61480,{er:a,batchId:m});L(v.userId===this.userId,10503,"Unexpected user for mutation batch",{userId:v.userId,batchId:m}),i.push(Ze(this.serializer,v))}));c.done()})).next((()=>i))}getAllMutationBatchesAffectingDocumentKeys(t,e){let n=new et(z);const s=[];return e.forEach((i=>{const a=Ws(this.userId,i.path),u=IDBKeyRange.lowerBound(a),c=kn(t).ee({range:u},((h,f,m)=>{const[p,v,C]=h,N=Xt(v);p===this.userId&&i.path.isEqual(N)?n=n.add(C):m.done()}));s.push(c)})),A.waitFor(s).next((()=>this.tr(t,n)))}getAllMutationBatchesAffectingQuery(t,e){const n=e.path,s=n.length+1,i=Ws(this.userId,n),a=IDBKeyRange.lowerBound(i);let u=new et(z);return kn(t).ee({range:a},((c,h,f)=>{const[m,p,v]=c,C=Xt(p);m===this.userId&&n.isPrefixOf(C)?C.length===s&&(u=u.add(v)):f.done()})).next((()=>this.tr(t,u)))}tr(t,e){const n=[],s=[];return e.forEach((i=>{s.push(Ee(t).get(i).next((a=>{if(a===null)throw O(35274,{batchId:i});L(a.userId===this.userId,9748,"Unexpected user for mutation batch",{userId:a.userId,batchId:i}),n.push(Ze(this.serializer,a))})))})),A.waitFor(s).next((()=>n))}removeMutationBatch(t,e){return _d(t.le,this.userId,e).next((n=>(t.addOnCommittedListener((()=>{this.nr(e.batchId)})),A.forEach(n,(s=>this.referenceDelegate.markPotentiallyOrphaned(t,s))))))}nr(t){delete this.Zn[t]}performConsistencyCheck(t){return this.checkEmpty(t).next((e=>{if(!e)return A.resolve();const n=IDBKeyRange.lowerBound((function(a){return[a]})(this.userId)),s=[];return kn(t).ee({range:n},((i,a,u)=>{if(i[0]===this.userId){const c=Xt(i[1]);s.push(c)}else u.done()})).next((()=>{L(s.length===0,56720,{rr:s.map((i=>i.canonicalString()))})}))}))}containsKey(t,e){return yd(t,this.userId,e)}ir(t){return Id(t).get(this.userId).next((e=>e||{userId:this.userId,lastAcknowledgedBatchId:be,lastStreamToken:""}))}}function yd(r,t,e){const n=Ws(t,e.path),s=n[1],i=IDBKeyRange.lowerBound(n);let a=!1;return kn(r).ee({range:i,Y:!0},((u,c,h)=>{const[f,m,p]=u;f===t&&m===s&&(a=!0),h.done()})).next((()=>a))}function Ee(r){return Tt(r,Qt)}function kn(r){return Tt(r,jn)}function Id(r){return Tt(r,Yr)}/**
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
 */class mn{constructor(t){this.sr=t}next(){return this.sr+=2,this.sr}static _r(){return new mn(0)}static ar(){return new mn(-1)}}/**
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
 */class lp{constructor(t,e){this.referenceDelegate=t,this.serializer=e}allocateTargetId(t){return this.ur(t).next((e=>{const n=new mn(e.highestTargetId);return e.highestTargetId=n.next(),this.cr(t,e).next((()=>e.highestTargetId))}))}getLastRemoteSnapshotVersion(t){return this.ur(t).next((e=>B.fromTimestamp(new Z(e.lastRemoteSnapshotVersion.seconds,e.lastRemoteSnapshotVersion.nanoseconds))))}getHighestSequenceNumber(t){return this.ur(t).next((e=>e.highestListenSequenceNumber))}setTargetsMetadata(t,e,n){return this.ur(t).next((s=>(s.highestListenSequenceNumber=e,n&&(s.lastRemoteSnapshotVersion=n.toTimestamp()),e>s.highestListenSequenceNumber&&(s.highestListenSequenceNumber=e),this.cr(t,s))))}addTargetData(t,e){return this.lr(t,e).next((()=>this.ur(t).next((n=>(n.targetCount+=1,this.hr(e,n),this.cr(t,n))))))}updateTargetData(t,e){return this.lr(t,e)}removeTargetData(t,e){return this.removeMatchingKeysForTargetId(t,e.targetId).next((()=>Cn(t).delete(e.targetId))).next((()=>this.ur(t))).next((n=>(L(n.targetCount>0,8065),n.targetCount-=1,this.cr(t,n))))}removeTargets(t,e,n){let s=0;const i=[];return Cn(t).ee(((a,u)=>{const c=Br(u);c.sequenceNumber<=e&&n.get(c.targetId)===null&&(s++,i.push(this.removeTargetData(t,c)))})).next((()=>A.waitFor(i))).next((()=>s))}forEachTarget(t,e){return Cn(t).ee(((n,s)=>{const i=Br(s);e(i)}))}ur(t){return el(t).get(ai).next((e=>(L(e!==null,2888),e)))}cr(t,e){return el(t).put(ai,e)}lr(t,e){return Cn(t).put(fd(this.serializer,e))}hr(t,e){let n=!1;return t.targetId>e.highestTargetId&&(e.highestTargetId=t.targetId,n=!0),t.sequenceNumber>e.highestListenSequenceNumber&&(e.highestListenSequenceNumber=t.sequenceNumber,n=!0),n}getTargetCount(t){return this.ur(t).next((e=>e.targetCount))}getTargetData(t,e){const n=cn(e),s=IDBKeyRange.bound([n,Number.NEGATIVE_INFINITY],[n,Number.POSITIVE_INFINITY]);let i=null;return Cn(t).ee({range:s,index:ih},((a,u,c)=>{const h=Br(u);ds(e,h.target)&&(i=h,c.done())})).next((()=>i))}addMatchingKeys(t,e,n){const s=[],i=ve(t);return e.forEach((a=>{const u=xt(a.path);s.push(i.put({targetId:n,path:u})),s.push(this.referenceDelegate.addReference(t,n,a))})),A.waitFor(s)}removeMatchingKeys(t,e,n){const s=ve(t);return A.forEach(e,(i=>{const a=xt(i.path);return A.waitFor([s.delete([n,a]),this.referenceDelegate.removeReference(t,n,i)])}))}removeMatchingKeysForTargetId(t,e){const n=ve(t),s=IDBKeyRange.bound([e],[e+1],!1,!0);return n.delete(s)}getMatchingKeysForTargetId(t,e){const n=IDBKeyRange.bound([e],[e+1],!1,!0),s=ve(t);let i=G();return s.ee({range:n,Y:!0},((a,u,c)=>{const h=Xt(a[1]),f=new k(h);i=i.add(f)})).next((()=>i))}containsKey(t,e){const n=xt(e.path),s=IDBKeyRange.bound([n],[Wl(n)],!1,!0);let i=0;return ve(t).ee({index:ia,Y:!0,range:s},(([a,u],c,h)=>{a!==0&&(i++,h.done())})).next((()=>i>0))}At(t,e){return Cn(t).get(e).next((n=>n?Br(n):null))}}function Cn(r){return Tt(r,zn)}function el(r){return Tt(r,sn)}function ve(r){return Tt(r,Gn)}/**
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
 */const nl="LruGarbageCollector",Td=1048576;function rl([r,t],[e,n]){const s=z(r,e);return s===0?z(t,n):s}class hp{constructor(t){this.Pr=t,this.buffer=new et(rl),this.Tr=0}Ir(){return++this.Tr}Er(t){const e=[t,this.Ir()];if(this.buffer.size<this.Pr)this.buffer=this.buffer.add(e);else{const n=this.buffer.last();rl(e,n)<0&&(this.buffer=this.buffer.delete(n).add(e))}}get maxValue(){return this.buffer.last()[0]}}class Ed{constructor(t,e,n){this.garbageCollector=t,this.asyncQueue=e,this.localStore=n,this.Rr=null}start(){this.garbageCollector.params.cacheSizeCollectionThreshold!==-1&&this.Ar(6e4)}stop(){this.Rr&&(this.Rr.cancel(),this.Rr=null)}get started(){return this.Rr!==null}Ar(t){x(nl,`Garbage collection scheduled in ${t}ms`),this.Rr=this.asyncQueue.enqueueAfterDelay("lru_garbage_collection",t,(async()=>{this.Rr=null;try{await this.localStore.collectGarbage(this.garbageCollector)}catch(e){Le(e)?x(nl,"Ignoring IndexedDB error during garbage collection: ",e):await Oe(e)}await this.Ar(3e5)}))}}class dp{constructor(t,e){this.Vr=t,this.params=e}calculateTargetCount(t,e){return this.Vr.dr(t).next((n=>Math.floor(e/100*n)))}nthSequenceNumber(t,e){if(e===0)return A.resolve(Mt.ce);const n=new hp(e);return this.Vr.forEachTarget(t,(s=>n.Er(s.sequenceNumber))).next((()=>this.Vr.mr(t,(s=>n.Er(s))))).next((()=>n.maxValue))}removeTargets(t,e,n){return this.Vr.removeTargets(t,e,n)}removeOrphanedDocuments(t,e){return this.Vr.removeOrphanedDocuments(t,e)}collect(t,e){return this.params.cacheSizeCollectionThreshold===-1?(x("LruGarbageCollector","Garbage collection skipped; disabled"),A.resolve(tl)):this.getCacheSize(t).next((n=>n<this.params.cacheSizeCollectionThreshold?(x("LruGarbageCollector",`Garbage collection skipped; Cache size ${n} is lower than threshold ${this.params.cacheSizeCollectionThreshold}`),tl):this.gr(t,e)))}getCacheSize(t){return this.Vr.getCacheSize(t)}gr(t,e){let n,s,i,a,u,c,h;const f=Date.now();return this.calculateTargetCount(t,this.params.percentileToCollect).next((m=>(m>this.params.maximumSequenceNumbersToCollect?(x("LruGarbageCollector",`Capping sequence numbers to collect down to the maximum of ${this.params.maximumSequenceNumbersToCollect} from ${m}`),s=this.params.maximumSequenceNumbersToCollect):s=m,a=Date.now(),this.nthSequenceNumber(t,s)))).next((m=>(n=m,u=Date.now(),this.removeTargets(t,n,e)))).next((m=>(i=m,c=Date.now(),this.removeOrphanedDocuments(t,n)))).next((m=>(h=Date.now(),xn()<=ie.DEBUG&&x("LruGarbageCollector",`LRU Garbage Collection
	Counted targets in ${a-f}ms
	Determined least recently used ${s} in `+(u-a)+`ms
	Removed ${i} targets in `+(c-u)+`ms
	Removed ${m} documents in `+(h-c)+`ms
Total Duration: ${h-f}ms`),A.resolve({didRun:!0,sequenceNumbersCollected:s,targetsRemoved:i,documentsRemoved:m}))))}}function wd(r,t){return new dp(r,t)}/**
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
 */class fp{constructor(t,e){this.db=t,this.garbageCollector=wd(this,e)}dr(t){const e=this.pr(t);return this.db.getTargetCache().getTargetCount(t).next((n=>e.next((s=>n+s))))}pr(t){let e=0;return this.mr(t,(n=>{e++})).next((()=>e))}forEachTarget(t,e){return this.db.getTargetCache().forEachTarget(t,e)}mr(t,e){return this.yr(t,((n,s)=>e(s)))}addReference(t,e,n){return zs(t,n)}removeReference(t,e,n){return zs(t,n)}removeTargets(t,e,n){return this.db.getTargetCache().removeTargets(t,e,n)}markPotentiallyOrphaned(t,e){return zs(t,e)}wr(t,e){return(function(s,i){let a=!1;return Id(s).te((u=>yd(s,u,i).next((c=>(c&&(a=!0),A.resolve(!c)))))).next((()=>a))})(t,e)}removeOrphanedDocuments(t,e){const n=this.db.getRemoteDocumentCache().newChangeBuffer(),s=[];let i=0;return this.yr(t,((a,u)=>{if(u<=e){const c=this.wr(t,a).next((h=>{if(!h)return i++,n.getEntry(t,a).next((()=>(n.removeEntry(a,B.min()),ve(t).delete((function(m){return[0,xt(m.path)]})(a)))))}));s.push(c)}})).next((()=>A.waitFor(s))).next((()=>n.apply(t))).next((()=>i))}removeTarget(t,e){const n=e.withSequenceNumber(t.currentSequenceNumber);return this.db.getTargetCache().updateTargetData(t,n)}updateLimboDocument(t,e){return zs(t,e)}yr(t,e){const n=ve(t);let s,i=Mt.ce;return n.ee({index:ia},(([a,u],{path:c,sequenceNumber:h})=>{a===0?(i!==Mt.ce&&e(new k(Xt(s)),i),i=h,s=c):i=Mt.ce})).next((()=>{i!==Mt.ce&&e(new k(Xt(s)),i)}))}getCacheSize(t){return this.db.getRemoteDocumentCache().getSize(t)}}function zs(r,t){return ve(r).put((function(n,s){return{targetId:0,path:xt(n.path),sequenceNumber:s}})(t,r.currentSequenceNumber))}/**
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
 */class Ad{constructor(){this.changes=new he((t=>t.toString()),((t,e)=>t.isEqual(e))),this.changesApplied=!1}addEntry(t){this.assertNotApplied(),this.changes.set(t.key,t)}removeEntry(t,e){this.assertNotApplied(),this.changes.set(t,at.newInvalidDocument(t).setReadTime(e))}getEntry(t,e){this.assertNotApplied();const n=this.changes.get(e);return n!==void 0?A.resolve(n):this.getFromCache(t,e)}getEntries(t,e){return this.getAllFromCache(t,e)}apply(t){return this.assertNotApplied(),this.changesApplied=!0,this.applyChanges(t)}assertNotApplied(){}}/**
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
 */class mp{constructor(t){this.serializer=t}setIndexManager(t){this.indexManager=t}addEntry(t,e,n){return He(t).put(n)}removeEntry(t,e,n){return He(t).delete((function(i,a){const u=i.path.toArray();return[u.slice(0,u.length-2),u[u.length-2],hi(a),u[u.length-1]]})(e,n))}updateMetadata(t,e){return this.getMetadata(t).next((n=>(n.byteSize+=e,this.br(t,n))))}getEntry(t,e){let n=at.newInvalidDocument(e);return He(t).ee({index:Hs,range:IDBKeyRange.only(kr(e))},((s,i)=>{n=this.Sr(e,i)})).next((()=>n))}Dr(t,e){let n={size:0,document:at.newInvalidDocument(e)};return He(t).ee({index:Hs,range:IDBKeyRange.only(kr(e))},((s,i)=>{n={document:this.Sr(e,i),size:fi(i)}})).next((()=>n))}getEntries(t,e){let n=Lt();return this.Cr(t,e,((s,i)=>{const a=this.Sr(s,i);n=n.insert(s,a)})).next((()=>n))}vr(t,e){let n=Lt(),s=new it(k.comparator);return this.Cr(t,e,((i,a)=>{const u=this.Sr(i,a);n=n.insert(i,u),s=s.insert(i,fi(a))})).next((()=>({documents:n,Fr:s})))}Cr(t,e,n){if(e.isEmpty())return A.resolve();let s=new et(ol);e.forEach((c=>s=s.add(c)));const i=IDBKeyRange.bound(kr(s.first()),kr(s.last())),a=s.getIterator();let u=a.getNext();return He(t).ee({index:Hs,range:i},((c,h,f)=>{const m=k.fromSegments([...h.prefixPath,h.collectionGroup,h.documentId]);for(;u&&ol(u,m)<0;)n(u,null),u=a.getNext();u&&u.isEqual(m)&&(n(u,h),u=a.hasNext()?a.getNext():null),u?f.j(kr(u)):f.done()})).next((()=>{for(;u;)n(u,null),u=a.hasNext()?a.getNext():null}))}getDocumentsMatchingQuery(t,e,n,s,i){const a=e.path,u=[a.popLast().toArray(),a.lastSegment(),hi(n.readTime),n.documentKey.path.isEmpty()?"":n.documentKey.path.lastSegment()],c=[a.popLast().toArray(),a.lastSegment(),[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER],""];return He(t).H(IDBKeyRange.bound(u,c,!0)).next((h=>{i==null||i.incrementDocumentReadCount(h.length);let f=Lt();for(const m of h){const p=this.Sr(k.fromSegments(m.prefixPath.concat(m.collectionGroup,m.documentId)),m);p.isFoundDocument()&&(ms(e,p)||s.has(p.key))&&(f=f.insert(p.key,p))}return f}))}getAllFromCollectionGroup(t,e,n,s){let i=Lt();const a=il(e,n),u=il(e,Kt.max());return He(t).ee({index:sh,range:IDBKeyRange.bound(a,u,!0)},((c,h,f)=>{const m=this.Sr(k.fromSegments(h.prefixPath.concat(h.collectionGroup,h.documentId)),h);i=i.insert(m.key,m),i.size===s&&f.done()})).next((()=>i))}newChangeBuffer(t){return new gp(this,!!t&&t.trackRemovals)}getSize(t){return this.getMetadata(t).next((e=>e.byteSize))}getMetadata(t){return sl(t).get(xo).next((e=>(L(!!e,20021),e)))}br(t,e){return sl(t).put(xo,e)}Sr(t,e){if(e){const n=tp(this.serializer,e);if(!(n.isNoDocument()&&n.version.isEqual(B.min())))return n}return at.newInvalidDocument(t)}}function vd(r){return new mp(r)}class gp extends Ad{constructor(t,e){super(),this.Mr=t,this.trackRemovals=e,this.Or=new he((n=>n.toString()),((n,s)=>n.isEqual(s)))}applyChanges(t){const e=[];let n=0,s=new et(((i,a)=>z(i.canonicalString(),a.canonicalString())));return this.changes.forEach(((i,a)=>{const u=this.Or.get(i);if(e.push(this.Mr.removeEntry(t,i,u.readTime)),a.isValidDocument()){const c=Uc(this.Mr.serializer,a);s=s.add(i.path.popLast());const h=fi(c);n+=h-u.size,e.push(this.Mr.addEntry(t,i,c))}else if(n-=u.size,this.trackRemovals){const c=Uc(this.Mr.serializer,a.convertToNoDocument(B.min()));e.push(this.Mr.addEntry(t,i,c))}})),s.forEach((i=>{e.push(this.Mr.indexManager.addToCollectionParentIndex(t,i))})),e.push(this.Mr.updateMetadata(t,n)),A.waitFor(e)}getFromCache(t,e){return this.Mr.Dr(t,e).next((n=>(this.Or.set(e,{size:n.size,readTime:n.document.readTime}),n.document)))}getAllFromCache(t,e){return this.Mr.vr(t,e).next((({documents:n,Fr:s})=>(s.forEach(((i,a)=>{this.Or.set(i,{size:a,readTime:n.get(i).readTime})})),n)))}}function sl(r){return Tt(r,Xr)}function He(r){return Tt(r,oi)}function kr(r){const t=r.path.toArray();return[t.slice(0,t.length-2),t[t.length-2],t[t.length-1]]}function il(r,t){const e=t.documentKey.path.toArray();return[r,hi(t.readTime),e.slice(0,e.length-2),e.length>0?e[e.length-1]:""]}function ol(r,t){const e=r.path.toArray(),n=t.path.toArray();let s=0;for(let i=0;i<e.length-2&&i<n.length-2;++i)if(s=z(e[i],n[i]),s)return s;return s=z(e.length,n.length),s||(s=z(e[e.length-2],n[n.length-2]),s||z(e[e.length-1],n[n.length-1]))}/**
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
 *//**
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
 */class pp{constructor(t,e){this.overlayedDocument=t,this.mutatedFields=e}}/**
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
 */class Rd{constructor(t,e,n,s){this.remoteDocumentCache=t,this.mutationQueue=e,this.documentOverlayCache=n,this.indexManager=s}getDocument(t,e){let n=null;return this.documentOverlayCache.getOverlay(t,e).next((s=>(n=s,this.remoteDocumentCache.getEntry(t,e)))).next((s=>(n!==null&&Qr(n.mutation,s,Ot.empty(),Z.now()),s)))}getDocuments(t,e){return this.remoteDocumentCache.getEntries(t,e).next((n=>this.getLocalViewOfDocuments(t,n,G()).next((()=>n))))}getLocalViewOfDocuments(t,e,n=G()){const s=Zt();return this.populateOverlays(t,s,e).next((()=>this.computeViews(t,e,s,n).next((i=>{let a=Lr();return i.forEach(((u,c)=>{a=a.insert(u,c.overlayedDocument)})),a}))))}getOverlayedDocuments(t,e){const n=Zt();return this.populateOverlays(t,n,e).next((()=>this.computeViews(t,e,n,G())))}populateOverlays(t,e,n){const s=[];return n.forEach((i=>{e.has(i)||s.push(i)})),this.documentOverlayCache.getOverlays(t,s).next((i=>{i.forEach(((a,u)=>{e.set(a,u)}))}))}computeViews(t,e,n,s){let i=Lt();const a=$r(),u=(function(){return $r()})();return e.forEach(((c,h)=>{const f=n.get(h.key);s.has(h.key)&&(f===void 0||f.mutation instanceof de)?i=i.insert(h.key,h):f!==void 0?(a.set(h.key,f.mutation.getFieldMask()),Qr(f.mutation,h,f.mutation.getFieldMask(),Z.now())):a.set(h.key,Ot.empty())})),this.recalculateAndSaveOverlays(t,i).next((c=>(c.forEach(((h,f)=>a.set(h,f))),e.forEach(((h,f)=>u.set(h,new pp(f,a.get(h)??null)))),u)))}recalculateAndSaveOverlays(t,e){const n=$r();let s=new it(((a,u)=>a-u)),i=G();return this.mutationQueue.getAllMutationBatchesAffectingDocumentKeys(t,e).next((a=>{for(const u of a)u.keys().forEach((c=>{const h=e.get(c);if(h===null)return;let f=n.get(c)||Ot.empty();f=u.applyToLocalView(h,f),n.set(c,f);const m=(s.get(u.batchId)||G()).add(c);s=s.insert(u.batchId,m)}))})).next((()=>{const a=[],u=s.getReverseIterator();for(;u.hasNext();){const c=u.getNext(),h=c.key,f=c.value,m=qh();f.forEach((p=>{if(!i.has(p)){const v=$h(e.get(p),n.get(p));v!==null&&m.set(p,v),i=i.add(p)}})),a.push(this.documentOverlayCache.saveOverlays(t,h,m))}return A.waitFor(a)})).next((()=>n))}recalculateAndSaveOverlaysForDocumentKeys(t,e){return this.remoteDocumentCache.getEntries(t,e).next((n=>this.recalculateAndSaveOverlays(t,n)))}getDocumentsMatchingQuery(t,e,n,s){return wg(e)?this.getDocumentsMatchingDocumentQuery(t,e.path):da(e)?this.getDocumentsMatchingCollectionGroupQuery(t,e,n,s):this.getDocumentsMatchingCollectionQuery(t,e,n,s)}getNextDocuments(t,e,n,s){return this.remoteDocumentCache.getAllFromCollectionGroup(t,e,n,s).next((i=>{const a=s-i.size>0?this.documentOverlayCache.getOverlaysForCollectionGroup(t,e,n.largestBatchId,s-i.size):A.resolve(Zt());let u=qn,c=i;return a.next((h=>A.forEach(h,((f,m)=>(u<m.largestBatchId&&(u=m.largestBatchId),i.get(f)?A.resolve():this.remoteDocumentCache.getEntry(t,f).next((p=>{c=c.insert(f,p)}))))).next((()=>this.populateOverlays(t,h,i))).next((()=>this.computeViews(t,c,h,G()))).next((f=>({batchId:u,changes:Lh(f)})))))}))}getDocumentsMatchingDocumentQuery(t,e){return this.getDocument(t,new k(e)).next((n=>{let s=Lr();return n.isFoundDocument()&&(s=s.insert(n.key,n)),s}))}getDocumentsMatchingCollectionGroupQuery(t,e,n,s){const i=e.collectionGroup;let a=Lr();return this.indexManager.getCollectionParents(t,i).next((u=>A.forEach(u,(c=>{const h=(function(m,p){return new le(p,null,m.explicitOrderBy.slice(),m.filters.slice(),m.limit,m.limitType,m.startAt,m.endAt)})(e,c.child(i));return this.getDocumentsMatchingCollectionQuery(t,h,n,s).next((f=>{f.forEach(((m,p)=>{a=a.insert(m,p)}))}))})).next((()=>a))))}getDocumentsMatchingCollectionQuery(t,e,n,s){let i;return this.documentOverlayCache.getOverlaysForCollection(t,e.path,n.largestBatchId).next((a=>(i=a,this.remoteDocumentCache.getDocumentsMatchingQuery(t,e,n,i,s)))).next((a=>{i.forEach(((c,h)=>{const f=h.getKey();a.get(f)===null&&(a=a.insert(f,at.newInvalidDocument(f)))}));let u=Lr();return a.forEach(((c,h)=>{const f=i.get(c);f!==void 0&&Qr(f.mutation,h,Ot.empty(),Z.now()),ms(e,h)&&(u=u.insert(c,h))})),u}))}}/**
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
 */class _p{constructor(t){this.serializer=t,this.Nr=new Map,this.Br=new Map}getBundleMetadata(t,e){return A.resolve(this.Nr.get(e))}saveBundleMetadata(t,e){return this.Nr.set(e.id,(function(s){return{id:s.id,version:s.version,createTime:gt(s.createTime)}})(e)),A.resolve()}getNamedQuery(t,e){return A.resolve(this.Br.get(e))}saveNamedQuery(t,e){return this.Br.set(e.name,(function(s){return{name:s.name,query:Di(s.bundledQuery),readTime:gt(s.readTime)}})(e)),A.resolve()}}/**
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
 */class yp{constructor(){this.overlays=new it(k.comparator),this.Lr=new Map}getOverlay(t,e){return A.resolve(this.overlays.get(e))}getOverlays(t,e){const n=Zt();return A.forEach(e,(s=>this.getOverlay(t,s).next((i=>{i!==null&&n.set(s,i)})))).next((()=>n))}saveOverlays(t,e,n){return n.forEach(((s,i)=>{this.bt(t,e,i)})),A.resolve()}removeOverlaysForBatchId(t,e,n){const s=this.Lr.get(n);return s!==void 0&&(s.forEach((i=>this.overlays=this.overlays.remove(i))),this.Lr.delete(n)),A.resolve()}getOverlaysForCollection(t,e,n){const s=Zt(),i=e.length+1,a=new k(e.child("")),u=this.overlays.getIteratorFrom(a);for(;u.hasNext();){const c=u.getNext().value,h=c.getKey();if(!e.isPrefixOf(h.path))break;h.path.length===i&&c.largestBatchId>n&&s.set(c.getKey(),c)}return A.resolve(s)}getOverlaysForCollectionGroup(t,e,n,s){let i=new it(((h,f)=>h-f));const a=this.overlays.getIterator();for(;a.hasNext();){const h=a.getNext().value;if(h.getKey().getCollectionGroup()===e&&h.largestBatchId>n){let f=i.get(h.largestBatchId);f===null&&(f=Zt(),i=i.insert(h.largestBatchId,f)),f.set(h.getKey(),h)}}const u=Zt(),c=i.getIterator();for(;c.hasNext()&&(c.getNext().value.forEach(((h,f)=>u.set(h,f))),!(u.size()>=s)););return A.resolve(u)}bt(t,e,n){const s=this.overlays.get(n.key);if(s!==null){const a=this.Lr.get(s.largestBatchId).delete(n.key);this.Lr.set(s.largestBatchId,a)}this.overlays=this.overlays.insert(n.key,new ya(e,n));let i=this.Lr.get(e);i===void 0&&(i=G(),this.Lr.set(e,i)),this.Lr.set(e,i.add(n.key))}}/**
 * @license
 * Copyright 2024 Google LLC
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
 */class Ip{constructor(){this.sessionToken=ft.EMPTY_BYTE_STRING}getSessionToken(t){return A.resolve(this.sessionToken)}setSessionToken(t,e){return this.sessionToken=e,A.resolve()}}/**
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
 */class Aa{constructor(){this.kr=new et(wt.Kr),this.qr=new et(wt.Ur)}isEmpty(){return this.kr.isEmpty()}addReference(t,e){const n=new wt(t,e);this.kr=this.kr.add(n),this.qr=this.qr.add(n)}$r(t,e){t.forEach((n=>this.addReference(n,e)))}removeReference(t,e){this.Wr(new wt(t,e))}Qr(t,e){t.forEach((n=>this.removeReference(n,e)))}Gr(t){const e=new k(new $([])),n=new wt(e,t),s=new wt(e,t+1),i=[];return this.qr.forEachInRange([n,s],(a=>{this.Wr(a),i.push(a.key)})),i}zr(){this.kr.forEach((t=>this.Wr(t)))}Wr(t){this.kr=this.kr.delete(t),this.qr=this.qr.delete(t)}jr(t){const e=new k(new $([])),n=new wt(e,t),s=new wt(e,t+1);let i=G();return this.qr.forEachInRange([n,s],(a=>{i=i.add(a.key)})),i}containsKey(t){const e=new wt(t,0),n=this.kr.firstAfterOrEqual(e);return n!==null&&t.isEqual(n.key)}}class wt{constructor(t,e){this.key=t,this.Hr=e}static Kr(t,e){return k.comparator(t.key,e.key)||z(t.Hr,e.Hr)}static Ur(t,e){return z(t.Hr,e.Hr)||k.comparator(t.key,e.key)}}/**
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
 */class Tp{constructor(t,e){this.indexManager=t,this.referenceDelegate=e,this.mutationQueue=[],this.Yn=1,this.Jr=new et(wt.Kr)}checkEmpty(t){return A.resolve(this.mutationQueue.length===0)}addMutationBatch(t,e,n,s){const i=this.Yn;this.Yn++,this.mutationQueue.length>0&&this.mutationQueue[this.mutationQueue.length-1];const a=new pa(i,e,n,s);this.mutationQueue.push(a);for(const u of s)this.Jr=this.Jr.add(new wt(u.key,i)),this.indexManager.addToCollectionParentIndex(t,u.key.path.popLast());return A.resolve(a)}lookupMutationBatch(t,e){return A.resolve(this.Zr(e))}getNextMutationBatchAfterBatchId(t,e){const n=e+1,s=this.Xr(n),i=s<0?0:s;return A.resolve(this.mutationQueue.length>i?this.mutationQueue[i]:null)}getHighestUnacknowledgedBatchId(){return A.resolve(this.mutationQueue.length===0?be:this.Yn-1)}getAllMutationBatches(t){return A.resolve(this.mutationQueue.slice())}getAllMutationBatchesAffectingDocumentKey(t,e){const n=new wt(e,0),s=new wt(e,Number.POSITIVE_INFINITY),i=[];return this.Jr.forEachInRange([n,s],(a=>{const u=this.Zr(a.Hr);i.push(u)})),A.resolve(i)}getAllMutationBatchesAffectingDocumentKeys(t,e){let n=new et(z);return e.forEach((s=>{const i=new wt(s,0),a=new wt(s,Number.POSITIVE_INFINITY);this.Jr.forEachInRange([i,a],(u=>{n=n.add(u.Hr)}))})),A.resolve(this.Yr(n))}getAllMutationBatchesAffectingQuery(t,e){const n=e.path,s=n.length+1;let i=n;k.isDocumentKey(i)||(i=i.child(""));const a=new wt(new k(i),0);let u=new et(z);return this.Jr.forEachWhile((c=>{const h=c.key.path;return!!n.isPrefixOf(h)&&(h.length===s&&(u=u.add(c.Hr)),!0)}),a),A.resolve(this.Yr(u))}Yr(t){const e=[];return t.forEach((n=>{const s=this.Zr(n);s!==null&&e.push(s)})),e}removeMutationBatch(t,e){L(this.ei(e.batchId,"removed")===0,55003),this.mutationQueue.shift();let n=this.Jr;return A.forEach(e.mutations,(s=>{const i=new wt(s.key,e.batchId);return n=n.delete(i),this.referenceDelegate.markPotentiallyOrphaned(t,s.key)})).next((()=>{this.Jr=n}))}nr(t){}containsKey(t,e){const n=new wt(e,0),s=this.Jr.firstAfterOrEqual(n);return A.resolve(e.isEqual(s&&s.key))}performConsistencyCheck(t){return this.mutationQueue.length,A.resolve()}ei(t,e){return this.Xr(t)}Xr(t){return this.mutationQueue.length===0?0:t-this.mutationQueue[0].batchId}Zr(t){const e=this.Xr(t);return e<0||e>=this.mutationQueue.length?null:this.mutationQueue[e]}}/**
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
 */class Ep{constructor(t){this.ti=t,this.docs=(function(){return new it(k.comparator)})(),this.size=0}setIndexManager(t){this.indexManager=t}addEntry(t,e){const n=e.key,s=this.docs.get(n),i=s?s.size:0,a=this.ti(e);return this.docs=this.docs.insert(n,{document:e.mutableCopy(),size:a}),this.size+=a-i,this.indexManager.addToCollectionParentIndex(t,n.path.popLast())}removeEntry(t){const e=this.docs.get(t);e&&(this.docs=this.docs.remove(t),this.size-=e.size)}getEntry(t,e){const n=this.docs.get(e);return A.resolve(n?n.document.mutableCopy():at.newInvalidDocument(e))}getEntries(t,e){let n=Lt();return e.forEach((s=>{const i=this.docs.get(s);n=n.insert(s,i?i.document.mutableCopy():at.newInvalidDocument(s))})),A.resolve(n)}getDocumentsMatchingQuery(t,e,n,s){let i=Lt();const a=e.path,u=new k(a.child("__id-9223372036854775808__")),c=this.docs.getIteratorFrom(u);for(;c.hasNext();){const{key:h,value:{document:f}}=c.getNext();if(!a.isPrefixOf(h.path))break;h.path.length>a.length+1||ra(Xl(f),n)<=0||(s.has(f.key)||ms(e,f))&&(i=i.insert(f.key,f.mutableCopy()))}return A.resolve(i)}getAllFromCollectionGroup(t,e,n,s){O(9500)}ni(t,e){return A.forEach(this.docs,(n=>e(n)))}newChangeBuffer(t){return new wp(this)}getSize(t){return A.resolve(this.size)}}class wp extends Ad{constructor(t){super(),this.Mr=t}applyChanges(t){const e=[];return this.changes.forEach(((n,s)=>{s.isValidDocument()?e.push(this.Mr.addEntry(t,s)):this.Mr.removeEntry(n)})),A.waitFor(e)}getFromCache(t,e){return this.Mr.getEntry(t,e)}getAllFromCache(t,e){return this.Mr.getEntries(t,e)}}/**
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
 */class Ap{constructor(t){this.persistence=t,this.ri=new he((e=>cn(e)),ds),this.lastRemoteSnapshotVersion=B.min(),this.highestTargetId=0,this.ii=0,this.si=new Aa,this.targetCount=0,this.oi=mn._r()}forEachTarget(t,e){return this.ri.forEach(((n,s)=>e(s))),A.resolve()}getLastRemoteSnapshotVersion(t){return A.resolve(this.lastRemoteSnapshotVersion)}getHighestSequenceNumber(t){return A.resolve(this.ii)}allocateTargetId(t){return this.highestTargetId=this.oi.next(),A.resolve(this.highestTargetId)}setTargetsMetadata(t,e,n){return n&&(this.lastRemoteSnapshotVersion=n),e>this.ii&&(this.ii=e),A.resolve()}lr(t){this.ri.set(t.target,t);const e=t.targetId;e>this.highestTargetId&&(this.oi=new mn(e),this.highestTargetId=e),t.sequenceNumber>this.ii&&(this.ii=t.sequenceNumber)}addTargetData(t,e){return this.lr(e),this.targetCount+=1,A.resolve()}updateTargetData(t,e){return this.lr(e),A.resolve()}removeTargetData(t,e){return this.ri.delete(e.target),this.si.Gr(e.targetId),this.targetCount-=1,A.resolve()}removeTargets(t,e,n){let s=0;const i=[];return this.ri.forEach(((a,u)=>{u.sequenceNumber<=e&&n.get(u.targetId)===null&&(this.ri.delete(a),i.push(this.removeMatchingKeysForTargetId(t,u.targetId)),s++)})),A.waitFor(i).next((()=>s))}getTargetCount(t){return A.resolve(this.targetCount)}getTargetData(t,e){const n=this.ri.get(e)||null;return A.resolve(n)}addMatchingKeys(t,e,n){return this.si.$r(e,n),A.resolve()}removeMatchingKeys(t,e,n){this.si.Qr(e,n);const s=this.persistence.referenceDelegate,i=[];return s&&e.forEach((a=>{i.push(s.markPotentiallyOrphaned(t,a))})),A.waitFor(i)}removeMatchingKeysForTargetId(t,e){return this.si.Gr(e),A.resolve()}getMatchingKeysForTargetId(t,e){const n=this.si.jr(e);return A.resolve(n)}containsKey(t,e){return A.resolve(this.si.containsKey(e))}}/**
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
 */class va{constructor(t,e){this._i={},this.overlays={},this.ai=new Mt(0),this.ui=!1,this.ui=!0,this.ci=new Ip,this.referenceDelegate=t(this),this.li=new Ap(this),this.indexManager=new up,this.remoteDocumentCache=(function(s){return new Ep(s)})((n=>this.referenceDelegate.hi(n))),this.serializer=new dd(e),this.Pi=new _p(this.serializer)}start(){return Promise.resolve()}shutdown(){return this.ui=!1,Promise.resolve()}get started(){return this.ui}setDatabaseDeletedListener(){}setNetworkEnabled(){}getIndexManager(t){return this.indexManager}getDocumentOverlayCache(t){let e=this.overlays[t.toKey()];return e||(e=new yp,this.overlays[t.toKey()]=e),e}getMutationQueue(t,e){let n=this._i[t.toKey()];return n||(n=new Tp(e,this.referenceDelegate),this._i[t.toKey()]=n),n}getGlobalsCache(){return this.ci}getTargetCache(){return this.li}getRemoteDocumentCache(){return this.remoteDocumentCache}getBundleCache(){return this.Pi}runTransaction(t,e,n){x("MemoryPersistence","Starting transaction:",t);const s=new vp(this.ai.next());return this.referenceDelegate.Ti(),n(s).next((i=>this.referenceDelegate.Ii(s).next((()=>i)))).toPromise().then((i=>(s.raiseOnCommittedEvent(),i)))}Ei(t,e){return A.or(Object.values(this._i).map((n=>()=>n.containsKey(t,e))))}}class vp extends th{constructor(t){super(),this.currentSequenceNumber=t}}class Fi{constructor(t){this.persistence=t,this.Ri=new Aa,this.Ai=null}static Vi(t){return new Fi(t)}get di(){if(this.Ai)return this.Ai;throw O(60996)}addReference(t,e,n){return this.Ri.addReference(n,e),this.di.delete(n.toString()),A.resolve()}removeReference(t,e,n){return this.Ri.removeReference(n,e),this.di.add(n.toString()),A.resolve()}markPotentiallyOrphaned(t,e){return this.di.add(e.toString()),A.resolve()}removeTarget(t,e){this.Ri.Gr(e.targetId).forEach((s=>this.di.add(s.toString())));const n=this.persistence.getTargetCache();return n.getMatchingKeysForTargetId(t,e.targetId).next((s=>{s.forEach((i=>this.di.add(i.toString())))})).next((()=>n.removeTargetData(t,e)))}Ti(){this.Ai=new Set}Ii(t){const e=this.persistence.getRemoteDocumentCache().newChangeBuffer();return A.forEach(this.di,(n=>{const s=k.fromPath(n);return this.mi(t,s).next((i=>{i||e.removeEntry(s,B.min())}))})).next((()=>(this.Ai=null,e.apply(t))))}updateLimboDocument(t,e){return this.mi(t,e).next((n=>{n?this.di.delete(e.toString()):this.di.add(e.toString())}))}hi(t){return 0}mi(t,e){return A.or([()=>A.resolve(this.Ri.containsKey(e)),()=>this.persistence.getTargetCache().containsKey(t,e),()=>this.persistence.Ei(t,e)])}}class mi{constructor(t,e){this.persistence=t,this.fi=new he((n=>xt(n.path)),((n,s)=>n.isEqual(s))),this.garbageCollector=wd(this,e)}static Vi(t,e){return new mi(t,e)}Ti(){}Ii(t){return A.resolve()}forEachTarget(t,e){return this.persistence.getTargetCache().forEachTarget(t,e)}dr(t){const e=this.pr(t);return this.persistence.getTargetCache().getTargetCount(t).next((n=>e.next((s=>n+s))))}pr(t){let e=0;return this.mr(t,(n=>{e++})).next((()=>e))}mr(t,e){return A.forEach(this.fi,((n,s)=>this.wr(t,n,s).next((i=>i?A.resolve():e(s)))))}removeTargets(t,e,n){return this.persistence.getTargetCache().removeTargets(t,e,n)}removeOrphanedDocuments(t,e){let n=0;const s=this.persistence.getRemoteDocumentCache(),i=s.newChangeBuffer();return s.ni(t,(a=>this.wr(t,a,e).next((u=>{u||(n++,i.removeEntry(a,B.min()))})))).next((()=>i.apply(t))).next((()=>n))}markPotentiallyOrphaned(t,e){return this.fi.set(e,t.currentSequenceNumber),A.resolve()}removeTarget(t,e){const n=e.withSequenceNumber(t.currentSequenceNumber);return this.persistence.getTargetCache().updateTargetData(t,n)}addReference(t,e,n){return this.fi.set(n,t.currentSequenceNumber),A.resolve()}removeReference(t,e,n){return this.fi.set(n,t.currentSequenceNumber),A.resolve()}updateLimboDocument(t,e){return this.fi.set(e,t.currentSequenceNumber),A.resolve()}hi(t){let e=t.key.toString().length;return t.isFoundDocument()&&(e+=Ys(t.data.value)),e}wr(t,e,n){return A.or([()=>this.persistence.Ei(t,e),()=>this.persistence.getTargetCache().containsKey(t,e),()=>{const s=this.fi.get(e);return A.resolve(s!==void 0&&s>n)}])}getCacheSize(t){return this.persistence.getRemoteDocumentCache().getSize(t)}}/**
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
 */class Rp{constructor(t){this.serializer=t}k(t,e,n,s){const i=new Ei("createOrUpgrade",e);n<1&&s>=1&&((function(c){c.createObjectStore(hs)})(t),(function(c){c.createObjectStore(Yr,{keyPath:Lm}),c.createObjectStore(Qt,{keyPath:_c,autoIncrement:!0}).createIndex(nn,yc,{unique:!0}),c.createObjectStore(jn)})(t),al(t),(function(c){c.createObjectStore(Ye)})(t));let a=A.resolve();return n<3&&s>=3&&(n!==0&&((function(c){c.deleteObjectStore(Gn),c.deleteObjectStore(zn),c.deleteObjectStore(sn)})(t),al(t)),a=a.next((()=>(function(c){const h=c.store(sn),f={highestTargetId:0,highestListenSequenceNumber:0,lastRemoteSnapshotVersion:B.min().toTimestamp(),targetCount:0};return h.put(ai,f)})(i)))),n<4&&s>=4&&(n!==0&&(a=a.next((()=>(function(c,h){return h.store(Qt).H().next((m=>{c.deleteObjectStore(Qt),c.createObjectStore(Qt,{keyPath:_c,autoIncrement:!0}).createIndex(nn,yc,{unique:!0});const p=h.store(Qt),v=m.map((C=>p.put(C)));return A.waitFor(v)}))})(t,i)))),a=a.next((()=>{(function(c){c.createObjectStore(Kn,{keyPath:Qm})})(t)}))),n<5&&s>=5&&(a=a.next((()=>this.gi(i)))),n<6&&s>=6&&(a=a.next((()=>((function(c){c.createObjectStore(Xr)})(t),this.pi(i))))),n<7&&s>=7&&(a=a.next((()=>this.yi(i)))),n<8&&s>=8&&(a=a.next((()=>this.wi(t,i)))),n<9&&s>=9&&(a=a.next((()=>{(function(c){c.objectStoreNames.contains("remoteDocumentChanges")&&c.deleteObjectStore("remoteDocumentChanges")})(t)}))),n<10&&s>=10&&(a=a.next((()=>this.bi(i)))),n<11&&s>=11&&(a=a.next((()=>{(function(c){c.createObjectStore(wi,{keyPath:Wm})})(t),(function(c){c.createObjectStore(Ai,{keyPath:Hm})})(t)}))),n<12&&s>=12&&(a=a.next((()=>{(function(c){const h=c.createObjectStore(vi,{keyPath:ng});h.createIndex(No,rg,{unique:!1}),h.createIndex(uh,sg,{unique:!1})})(t)}))),n<13&&s>=13&&(a=a.next((()=>(function(c){const h=c.createObjectStore(oi,{keyPath:Bm});h.createIndex(Hs,Um),h.createIndex(sh,jm)})(t))).next((()=>this.Si(t,i))).next((()=>t.deleteObjectStore(Ye)))),n<14&&s>=14&&(a=a.next((()=>this.Di(t,i)))),n<15&&s>=15&&(a=a.next((()=>(function(c){c.createObjectStore(oa,{keyPath:Jm,autoIncrement:!0}).createIndex(Do,Ym,{unique:!1}),c.createObjectStore(zr,{keyPath:Xm}).createIndex(oh,Zm,{unique:!1}),c.createObjectStore(Gr,{keyPath:tg}).createIndex(ah,eg,{unique:!1})})(t)))),n<16&&s>=16&&(a=a.next((()=>{e.objectStore(zr).clear()})).next((()=>{e.objectStore(Gr).clear()}))),n<17&&s>=17&&(a=a.next((()=>{(function(c){c.createObjectStore(aa,{keyPath:ig})})(t)}))),n<18&&s>=18&&ql()&&(a=a.next((()=>{e.objectStore(zr).clear()})).next((()=>{e.objectStore(Gr).clear()}))),a}pi(t){let e=0;return t.store(Ye).ee(((n,s)=>{e+=fi(s)})).next((()=>{const n={byteSize:e};return t.store(Xr).put(xo,n)}))}gi(t){const e=t.store(Yr),n=t.store(Qt);return e.H().next((s=>A.forEach(s,(i=>{const a=IDBKeyRange.bound([i.userId,be],[i.userId,i.lastAcknowledgedBatchId]);return n.H(nn,a).next((u=>A.forEach(u,(c=>{L(c.userId===i.userId,18650,"Cannot process batch from unexpected user",{batchId:c.batchId});const h=Ze(this.serializer,c);return _d(t,i.userId,h).next((()=>{}))}))))}))))}yi(t){const e=t.store(Gn),n=t.store(Ye);return t.store(sn).get(ai).next((s=>{const i=[];return n.ee(((a,u)=>{const c=new $(a),h=(function(m){return[0,xt(m)]})(c);i.push(e.get(h).next((f=>f?A.resolve():(m=>e.put({targetId:0,path:xt(m),sequenceNumber:s.highestListenSequenceNumber}))(c))))})).next((()=>A.waitFor(i)))}))}wi(t,e){t.createObjectStore(Zr,{keyPath:$m});const n=e.store(Zr),s=new wa,i=a=>{if(s.add(a)){const u=a.lastSegment(),c=a.popLast();return n.put({collectionId:u,parent:xt(c)})}};return e.store(Ye).ee({Y:!0},((a,u)=>{const c=new $(a);return i(c.popLast())})).next((()=>e.store(jn).ee({Y:!0},(([a,u,c],h)=>{const f=Xt(u);return i(f.popLast())}))))}bi(t){const e=t.store(zn);return e.ee(((n,s)=>{const i=Br(s),a=fd(this.serializer,i);return e.put(a)}))}Si(t,e){const n=e.store(Ye),s=[];return n.ee(((i,a)=>{const u=e.store(oi),c=(function(m){return m.document?new k($.fromString(m.document.name).popFirst(5)):m.noDocument?k.fromSegments(m.noDocument.path):m.unknownDocument?k.fromSegments(m.unknownDocument.path):O(36783)})(a).path.toArray(),h={prefixPath:c.slice(0,c.length-2),collectionGroup:c[c.length-2],documentId:c[c.length-1],readTime:a.readTime||[0,0],unknownDocument:a.unknownDocument,noDocument:a.noDocument,document:a.document,hasCommittedMutations:!!a.hasCommittedMutations};s.push(u.put(h))})).next((()=>A.waitFor(s)))}Di(t,e){const n=e.store(Qt),s=vd(this.serializer),i=new va(Fi.Vi,this.serializer.yt);return n.H().next((a=>{const u=new Map;return a.forEach((c=>{let h=u.get(c.userId)??G();Ze(this.serializer,c).keys().forEach((f=>h=h.add(f))),u.set(c.userId,h)})),A.forEach(u,((c,h)=>{const f=new At(h),m=Ni.wt(this.serializer,f),p=i.getIndexManager(f),v=ki.wt(f,this.serializer,p,i.referenceDelegate);return new Rd(s,v,m,p).recalculateAndSaveOverlaysForDocumentKeys(new ko(e,Mt.ce),c).next()}))}))}}function al(r){r.createObjectStore(Gn,{keyPath:Gm}).createIndex(ia,Km,{unique:!0}),r.createObjectStore(zn,{keyPath:"targetId"}).createIndex(ih,zm,{unique:!0}),r.createObjectStore(sn)}const we="IndexedDbPersistence",Io=18e5,To=5e3,Eo="Failed to obtain exclusive access to the persistence layer. To allow shared access, multi-tab synchronization has to be enabled in all tabs. If you are using `experimentalForceOwningTab:true`, make sure that only one tab has persistence enabled at any given time.",Pd="main";class Ra{constructor(t,e,n,s,i,a,u,c,h,f,m=18){if(this.allowTabSynchronization=t,this.persistenceKey=e,this.clientId=n,this.Ci=i,this.window=a,this.document=u,this.Fi=h,this.Mi=f,this.xi=m,this.ai=null,this.ui=!1,this.isPrimary=!1,this.networkEnabled=!0,this.Oi=null,this.inForeground=!1,this.Ni=null,this.Bi=null,this.Li=Number.NEGATIVE_INFINITY,this.ki=p=>Promise.resolve(),!Ra.v())throw new b(P.UNIMPLEMENTED,"This platform is either missing IndexedDB or is known to have an incomplete implementation. Offline persistence has been disabled.");this.referenceDelegate=new fp(this,s),this.Ki=e+Pd,this.serializer=new dd(c),this.qi=new te(this.Ki,this.xi,new Rp(this.serializer)),this.ci=new np,this.li=new lp(this.referenceDelegate,this.serializer),this.remoteDocumentCache=vd(this.serializer),this.Pi=new ep,this.window&&this.window.localStorage?this.Ui=this.window.localStorage:(this.Ui=null,f===!1&&mt(we,"LocalStorage is unavailable. As a result, persistence may not work reliably. In particular enablePersistence() could fail immediately after refreshing the page."))}start(){return this.$i().then((()=>{if(!this.isPrimary&&!this.allowTabSynchronization)throw new b(P.FAILED_PRECONDITION,Eo);return this.Wi(),this.Qi(),this.Gi(),this.runTransaction("getHighestListenSequenceNumber","readonly",(t=>this.li.getHighestSequenceNumber(t)))})).then((t=>{this.ai=new Mt(t,this.Fi)})).then((()=>{this.ui=!0})).catch((t=>(this.qi&&this.qi.close(),Promise.reject(t))))}zi(t){return this.ki=async e=>{if(this.started)return t(e)},t(this.isPrimary)}setDatabaseDeletedListener(t){this.qi.q((async e=>{e.newVersion===null&&await t()}))}setNetworkEnabled(t){this.networkEnabled!==t&&(this.networkEnabled=t,this.Ci.enqueueAndForget((async()=>{this.started&&await this.$i()})))}$i(){return this.runTransaction("updateClientMetadataAndTryBecomePrimary","readwrite",(t=>Gs(t).put({clientId:this.clientId,updateTimeMs:Date.now(),networkEnabled:this.networkEnabled,inForeground:this.inForeground}).next((()=>{if(this.isPrimary)return this.ji(t).next((e=>{e||(this.isPrimary=!1,this.Ci.enqueueRetryable((()=>this.ki(!1))))}))})).next((()=>this.Hi(t))).next((e=>this.isPrimary&&!e?this.Ji(t).next((()=>!1)):!!e&&this.Zi(t).next((()=>!0)))))).catch((t=>{if(Le(t))return x(we,"Failed to extend owner lease: ",t),this.isPrimary;if(!this.allowTabSynchronization)throw t;return x(we,"Releasing owner lease after error during lease refresh",t),!1})).then((t=>{this.isPrimary!==t&&this.Ci.enqueueRetryable((()=>this.ki(t))),this.isPrimary=t}))}ji(t){return Fr(t).get(Rn).next((e=>A.resolve(this.Xi(e))))}Yi(t){return Gs(t).delete(this.clientId)}async es(){if(this.isPrimary&&!this.ts(this.Li,Io)){this.Li=Date.now();const t=await this.runTransaction("maybeGarbageCollectMultiClientState","readwrite-primary",(e=>{const n=Tt(e,Kn);return n.H().next((s=>{const i=this.ns(s,Io),a=s.filter((u=>i.indexOf(u)===-1));return A.forEach(a,(u=>n.delete(u.clientId))).next((()=>a))}))})).catch((()=>[]));if(this.Ui)for(const e of t)this.Ui.removeItem(this.rs(e.clientId))}}Gi(){this.Bi=this.Ci.enqueueAfterDelay("client_metadata_refresh",4e3,(()=>this.$i().then((()=>this.es())).then((()=>this.Gi()))))}Xi(t){return!!t&&t.ownerId===this.clientId}Hi(t){return this.Mi?A.resolve(!0):Fr(t).get(Rn).next((e=>{if(e!==null&&this.ts(e.leaseTimestampMs,To)&&!this.ss(e.ownerId)){if(this.Xi(e)&&this.networkEnabled)return!0;if(!this.Xi(e)){if(!e.allowTabSynchronization)throw new b(P.FAILED_PRECONDITION,Eo);return!1}}return!(!this.networkEnabled||!this.inForeground)||Gs(t).H().next((n=>this.ns(n,To).find((s=>{if(this.clientId!==s.clientId){const i=!this.networkEnabled&&s.networkEnabled,a=!this.inForeground&&s.inForeground,u=this.networkEnabled===s.networkEnabled;if(i||a&&u)return!0}return!1}))===void 0))})).next((e=>(this.isPrimary!==e&&x(we,`Client ${e?"is":"is not"} eligible for a primary lease.`),e)))}async shutdown(){this.ui=!1,this._s(),this.Bi&&(this.Bi.cancel(),this.Bi=null),this.us(),this.cs(),await this.qi.runTransaction("shutdown","readwrite",[hs,Kn],(t=>{const e=new ko(t,Mt.ce);return this.Ji(e).next((()=>this.Yi(e)))})),this.qi.close(),this.ls()}ns(t,e){return t.filter((n=>this.ts(n.updateTimeMs,e)&&!this.ss(n.clientId)))}hs(){return this.runTransaction("getActiveClients","readonly",(t=>Gs(t).H().next((e=>this.ns(e,Io).map((n=>n.clientId))))))}get started(){return this.ui}getGlobalsCache(){return this.ci}getMutationQueue(t,e){return ki.wt(t,this.serializer,e,this.referenceDelegate)}getTargetCache(){return this.li}getRemoteDocumentCache(){return this.remoteDocumentCache}getIndexManager(t){return new cp(t,this.serializer.yt.databaseId)}getDocumentOverlayCache(t){return Ni.wt(this.serializer,t)}getBundleCache(){return this.Pi}runTransaction(t,e,n){x(we,"Starting transaction:",t);const s=e==="readonly"?"readonly":"readwrite",i=(function(c){return c===18?ug:c===17?dh:c===16?ag:c===15?ua:c===14?hh:c===13?lh:c===12?og:c===11?ch:void O(60245)})(this.xi);let a;return this.qi.runTransaction(t,s,i,(u=>(a=new ko(u,this.ai?this.ai.next():Mt.ce),e==="readwrite-primary"?this.ji(a).next((c=>!!c||this.Hi(a))).next((c=>{if(!c)throw mt(`Failed to obtain primary lease for action '${t}'.`),this.isPrimary=!1,this.Ci.enqueueRetryable((()=>this.ki(!1))),new b(P.FAILED_PRECONDITION,Zl);return n(a)})).next((c=>this.Zi(a).next((()=>c)))):this.Ps(a).next((()=>n(a)))))).then((u=>(a.raiseOnCommittedEvent(),u)))}Ps(t){return Fr(t).get(Rn).next((e=>{if(e!==null&&this.ts(e.leaseTimestampMs,To)&&!this.ss(e.ownerId)&&!this.Xi(e)&&!(this.Mi||this.allowTabSynchronization&&e.allowTabSynchronization))throw new b(P.FAILED_PRECONDITION,Eo)}))}Zi(t){const e={ownerId:this.clientId,allowTabSynchronization:this.allowTabSynchronization,leaseTimestampMs:Date.now()};return Fr(t).put(Rn,e)}static v(){return te.v()}Ji(t){const e=Fr(t);return e.get(Rn).next((n=>this.Xi(n)?(x(we,"Releasing primary lease."),e.delete(Rn)):A.resolve()))}ts(t,e){const n=Date.now();return!(t<n-e)&&(!(t>n)||(mt(`Detected an update time that is in the future: ${t} > ${n}`),!1))}Wi(){this.document!==null&&typeof this.document.addEventListener=="function"&&(this.Ni=()=>{this.Ci.enqueueAndForget((()=>(this.inForeground=this.document.visibilityState==="visible",this.$i())))},this.document.addEventListener("visibilitychange",this.Ni),this.inForeground=this.document.visibilityState==="visible")}us(){this.Ni&&(this.document.removeEventListener("visibilitychange",this.Ni),this.Ni=null)}Qi(){var t;typeof((t=this.window)==null?void 0:t.addEventListener)=="function"&&(this.Oi=()=>{this._s();const e=/(?:Version|Mobile)\/1[456]/;Ll()&&(navigator.appVersion.match(e)||navigator.userAgent.match(e))&&this.Ci.enterRestrictedMode(!0),this.Ci.enqueueAndForget((()=>this.shutdown()))},this.window.addEventListener("pagehide",this.Oi))}cs(){this.Oi&&(this.window.removeEventListener("pagehide",this.Oi),this.Oi=null)}ss(t){var e;try{const n=((e=this.Ui)==null?void 0:e.getItem(this.rs(t)))!==null;return x(we,`Client '${t}' ${n?"is":"is not"} zombied in LocalStorage`),n}catch(n){return mt(we,"Failed to get zombied client id.",n),!1}}_s(){if(this.Ui)try{this.Ui.setItem(this.rs(this.clientId),String(Date.now()))}catch(t){mt("Failed to set zombie client id.",t)}}ls(){if(this.Ui)try{this.Ui.removeItem(this.rs(this.clientId))}catch{}}rs(t){return`firestore_zombie_${this.persistenceKey}_${t}`}}function Fr(r){return Tt(r,hs)}function Gs(r){return Tt(r,Kn)}function Pa(r,t){let e=r.projectId;return r.isDefaultDatabase||(e+="."+r.database),"firestore/"+t+"/"+e+"/"}/**
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
 */class Sa{constructor(t,e,n,s){this.targetId=t,this.fromCache=e,this.Ts=n,this.Is=s}static Es(t,e){let n=G(),s=G();for(const i of e.docChanges)switch(i.type){case 0:n=n.add(i.doc.key);break;case 1:s=s.add(i.doc.key)}return new Sa(t,e.fromCache,n,s)}}/**
 * @license
 * Copyright 2023 Google LLC
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
 */class Pp{constructor(){this._documentReadCount=0}get documentReadCount(){return this._documentReadCount}incrementDocumentReadCount(t){this._documentReadCount+=t}}/**
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
 */class Sd{constructor(){this.Rs=!1,this.As=!1,this.Vs=100,this.ds=(function(){return Ll()?8:eh(si())>0?6:4})()}initialize(t,e){this.fs=t,this.indexManager=e,this.Rs=!0}getDocumentsMatchingQuery(t,e,n,s){const i={result:null};return this.gs(t,e).next((a=>{i.result=a})).next((()=>{if(!i.result)return this.ps(t,e,s,n).next((a=>{i.result=a}))})).next((()=>{if(i.result)return;const a=new Pp;return this.ys(t,e,a).next((u=>{if(i.result=u,this.As)return this.ws(t,e,a,u.size)}))})).next((()=>i.result))}ws(t,e,n,s){return n.documentReadCount<this.Vs?(xn()<=ie.DEBUG&&x("QueryEngine","SDK will not create cache indexes for query:",Dn(e),"since it only creates cache indexes for collection contains","more than or equal to",this.Vs,"documents"),A.resolve()):(xn()<=ie.DEBUG&&x("QueryEngine","Query:",Dn(e),"scans",n.documentReadCount,"local documents and returns",s,"documents as results."),n.documentReadCount>this.ds*s?(xn()<=ie.DEBUG&&x("QueryEngine","The SDK decides to create cache indexes for query:",Dn(e),"as using cache indexes may help improve performance."),this.indexManager.createTargetIndexes(t,Dt(e))):A.resolve())}gs(t,e){if(xc(e))return A.resolve(null);let n=Dt(e);return this.indexManager.getIndexType(t,n).next((s=>s===0?null:(e.limit!==null&&s===1&&(e=li(e,null,"F"),n=Dt(e)),this.indexManager.getDocumentsMatchingTarget(t,n).next((i=>{const a=G(...i);return this.fs.getDocuments(t,a).next((u=>this.indexManager.getMinOffset(t,n).next((c=>{const h=this.bs(e,u);return this.Ss(e,h,a,c.readTime)?this.gs(t,li(e,null,"F")):this.Ds(t,h,e,c)}))))})))))}ps(t,e,n,s){return xc(e)||s.isEqual(B.min())?A.resolve(null):this.fs.getDocuments(t,n).next((i=>{const a=this.bs(e,i);return this.Ss(e,a,n,s)?A.resolve(null):(xn()<=ie.DEBUG&&x("QueryEngine","Re-using previous result from %s to execute query: %s",s.toString(),Dn(e)),this.Ds(t,a,e,Yl(s,qn)).next((u=>u)))}))}bs(t,e){let n=new et(Mh(t));return e.forEach(((s,i)=>{ms(t,i)&&(n=n.add(i))})),n}Ss(t,e,n,s){if(t.limit===null)return!1;if(n.size!==e.size)return!0;const i=t.limitType==="F"?e.last():e.first();return!!i&&(i.hasPendingWrites||i.version.compareTo(s)>0)}ys(t,e,n){return xn()<=ie.DEBUG&&x("QueryEngine","Using full collection scan to execute query:",Dn(e)),this.fs.getDocumentsMatchingQuery(t,e,Kt.min(),n)}Ds(t,e,n,s){return this.fs.getDocumentsMatchingQuery(t,n,s).next((i=>(e.forEach((a=>{i=i.insert(a.key,a)})),i)))}}/**
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
 */const Va="LocalStore",Sp=3e8;class Vp{constructor(t,e,n,s){this.persistence=t,this.Cs=e,this.serializer=s,this.vs=new it(z),this.Fs=new he((i=>cn(i)),ds),this.Ms=new Map,this.xs=t.getRemoteDocumentCache(),this.li=t.getTargetCache(),this.Pi=t.getBundleCache(),this.Os(n)}Os(t){this.documentOverlayCache=this.persistence.getDocumentOverlayCache(t),this.indexManager=this.persistence.getIndexManager(t),this.mutationQueue=this.persistence.getMutationQueue(t,this.indexManager),this.localDocuments=new Rd(this.xs,this.mutationQueue,this.documentOverlayCache,this.indexManager),this.xs.setIndexManager(this.indexManager),this.Cs.initialize(this.localDocuments,this.indexManager)}collectGarbage(t){return this.persistence.runTransaction("Collect garbage","readwrite-primary",(e=>t.collect(e,this.vs)))}}function Vd(r,t,e,n){return new Vp(r,t,e,n)}async function bd(r,t){const e=F(r);return await e.persistence.runTransaction("Handle user change","readonly",(n=>{let s;return e.mutationQueue.getAllMutationBatches(n).next((i=>(s=i,e.Os(t),e.mutationQueue.getAllMutationBatches(n)))).next((i=>{const a=[],u=[];let c=G();for(const h of s){a.push(h.batchId);for(const f of h.mutations)c=c.add(f.key)}for(const h of i){u.push(h.batchId);for(const f of h.mutations)c=c.add(f.key)}return e.localDocuments.getDocuments(n,c).next((h=>({Ns:h,removedBatchIds:a,addedBatchIds:u})))}))}))}function bp(r,t){const e=F(r);return e.persistence.runTransaction("Acknowledge batch","readwrite-primary",(n=>{const s=t.batch.keys(),i=e.xs.newChangeBuffer({trackRemovals:!0});return(function(u,c,h,f){const m=h.batch,p=m.keys();let v=A.resolve();return p.forEach((C=>{v=v.next((()=>f.getEntry(c,C))).next((N=>{const D=h.docVersions.get(C);L(D!==null,48541),N.version.compareTo(D)<0&&(m.applyToRemoteDocument(N,h),N.isValidDocument()&&(N.setReadTime(h.commitVersion),f.addEntry(N)))}))})),v.next((()=>u.mutationQueue.removeMutationBatch(c,m)))})(e,n,t,i).next((()=>i.apply(n))).next((()=>e.mutationQueue.performConsistencyCheck(n))).next((()=>e.documentOverlayCache.removeOverlaysForBatchId(n,s,t.batch.batchId))).next((()=>e.localDocuments.recalculateAndSaveOverlaysForDocumentKeys(n,(function(u){let c=G();for(let h=0;h<u.mutationResults.length;++h)u.mutationResults[h].transformResults.length>0&&(c=c.add(u.batch.mutations[h].key));return c})(t)))).next((()=>e.localDocuments.getDocuments(n,s)))}))}function Cd(r){const t=F(r);return t.persistence.runTransaction("Get last remote snapshot version","readonly",(e=>t.li.getLastRemoteSnapshotVersion(e)))}function Cp(r,t){const e=F(r),n=t.snapshotVersion;let s=e.vs;return e.persistence.runTransaction("Apply remote event","readwrite-primary",(i=>{const a=e.xs.newChangeBuffer({trackRemovals:!0});s=e.vs;const u=[];t.targetChanges.forEach(((f,m)=>{const p=s.get(m);if(!p)return;u.push(e.li.removeMatchingKeys(i,f.removedDocuments,m).next((()=>e.li.addMatchingKeys(i,f.addedDocuments,m))));let v=p.withSequenceNumber(i.currentSequenceNumber);t.targetMismatches.get(m)!==null?v=v.withResumeToken(ft.EMPTY_BYTE_STRING,B.min()).withLastLimboFreeSnapshotVersion(B.min()):f.resumeToken.approximateByteSize()>0&&(v=v.withResumeToken(f.resumeToken,n)),s=s.insert(m,v),(function(N,D,q){return N.resumeToken.approximateByteSize()===0||D.snapshotVersion.toMicroseconds()-N.snapshotVersion.toMicroseconds()>=Sp?!0:q.addedDocuments.size+q.modifiedDocuments.size+q.removedDocuments.size>0})(p,v,f)&&u.push(e.li.updateTargetData(i,v))}));let c=Lt(),h=G();if(t.documentUpdates.forEach((f=>{t.resolvedLimboDocuments.has(f)&&u.push(e.persistence.referenceDelegate.updateLimboDocument(i,f))})),u.push(xd(i,a,t.documentUpdates).next((f=>{c=f.Bs,h=f.Ls}))),!n.isEqual(B.min())){const f=e.li.getLastRemoteSnapshotVersion(i).next((m=>e.li.setTargetsMetadata(i,i.currentSequenceNumber,n)));u.push(f)}return A.waitFor(u).next((()=>a.apply(i))).next((()=>e.localDocuments.getLocalViewOfDocuments(i,c,h))).next((()=>c))})).then((i=>(e.vs=s,i)))}function xd(r,t,e){let n=G(),s=G();return e.forEach((i=>n=n.add(i))),t.getEntries(r,n).next((i=>{let a=Lt();return e.forEach(((u,c)=>{const h=i.get(u);c.isFoundDocument()!==h.isFoundDocument()&&(s=s.add(u)),c.isNoDocument()&&c.version.isEqual(B.min())?(t.removeEntry(u,c.readTime),a=a.insert(u,c)):!h.isValidDocument()||c.version.compareTo(h.version)>0||c.version.compareTo(h.version)===0&&h.hasPendingWrites?(t.addEntry(c),a=a.insert(u,c)):x(Va,"Ignoring outdated watch update for ",u,". Current version:",h.version," Watch version:",c.version)})),{Bs:a,Ls:s}}))}function xp(r,t){const e=F(r);return e.persistence.runTransaction("Get next mutation batch","readonly",(n=>(t===void 0&&(t=be),e.mutationQueue.getNextMutationBatchAfterBatchId(n,t))))}function Xn(r,t){const e=F(r);return e.persistence.runTransaction("Allocate target","readwrite",(n=>{let s;return e.li.getTargetData(n,t).next((i=>i?(s=i,A.resolve(s)):e.li.allocateTargetId(n).next((a=>(s=new oe(t,a,"TargetPurposeListen",n.currentSequenceNumber),e.li.addTargetData(n,s).next((()=>s)))))))})).then((n=>{const s=e.vs.get(n.targetId);return(s===null||n.snapshotVersion.compareTo(s.snapshotVersion)>0)&&(e.vs=e.vs.insert(n.targetId,n),e.Fs.set(t,n.targetId)),n}))}async function Zn(r,t,e){const n=F(r),s=n.vs.get(t),i=e?"readwrite":"readwrite-primary";try{e||await n.persistence.runTransaction("Release target",i,(a=>n.persistence.referenceDelegate.removeTarget(a,s)))}catch(a){if(!Le(a))throw a;x(Va,`Failed to update sequence numbers for target ${t}: ${a}`)}n.vs=n.vs.remove(t),n.Fs.delete(s.target)}function gi(r,t,e){const n=F(r);let s=B.min(),i=G();return n.persistence.runTransaction("Execute query","readwrite",(a=>(function(c,h,f){const m=F(c),p=m.Fs.get(f);return p!==void 0?A.resolve(m.vs.get(p)):m.li.getTargetData(h,f)})(n,a,Dt(t)).next((u=>{if(u)return s=u.lastLimboFreeSnapshotVersion,n.li.getMatchingKeysForTargetId(a,u.targetId).next((c=>{i=c}))})).next((()=>n.Cs.getDocumentsMatchingQuery(a,t,e?s:B.min(),e?i:G()))).next((u=>(kd(n,Fh(t),u),{documents:u,ks:i})))))}function Dd(r,t){const e=F(r),n=F(e.li),s=e.vs.get(t);return s?Promise.resolve(s.target):e.persistence.runTransaction("Get target data","readonly",(i=>n.At(i,t).next((a=>a?a.target:null))))}function Nd(r,t){const e=F(r),n=e.Ms.get(t)||B.min();return e.persistence.runTransaction("Get new document changes","readonly",(s=>e.xs.getAllFromCollectionGroup(s,t,Yl(n,qn),Number.MAX_SAFE_INTEGER))).then((s=>(kd(e,t,s),s)))}function kd(r,t,e){let n=r.Ms.get(t)||B.min();e.forEach(((s,i)=>{i.readTime.compareTo(n)>0&&(n=i.readTime)})),r.Ms.set(t,n)}async function Dp(r,t,e,n){const s=F(r);let i=G(),a=Lt();for(const h of e){const f=t.Ks(h.metadata.name);h.document&&(i=i.add(f));const m=t.qs(h);m.setReadTime(t.Us(h.metadata.readTime)),a=a.insert(f,m)}const u=s.xs.newChangeBuffer({trackRemovals:!0}),c=await Xn(s,(function(f){return Dt(ir($.fromString(`__bundle__/docs/${f}`)))})(n));return s.persistence.runTransaction("Apply bundle documents","readwrite",(h=>xd(h,u,a).next((f=>(u.apply(h),f))).next((f=>s.li.removeMatchingKeysForTargetId(h,c.targetId).next((()=>s.li.addMatchingKeys(h,i,c.targetId))).next((()=>s.localDocuments.getLocalViewOfDocuments(h,f.Bs,f.Ls))).next((()=>f.Bs))))))}async function Np(r,t,e=G()){const n=await Xn(r,Dt(Di(t.bundledQuery))),s=F(r);return s.persistence.runTransaction("Save named query","readwrite",(i=>{const a=gt(t.readTime);if(n.snapshotVersion.compareTo(a)>=0)return s.Pi.saveNamedQuery(i,t);const u=n.withResumeToken(ft.EMPTY_BYTE_STRING,a);return s.vs=s.vs.insert(u.targetId,u),s.li.updateTargetData(i,u).next((()=>s.li.removeMatchingKeysForTargetId(i,n.targetId))).next((()=>s.li.addMatchingKeys(i,e,n.targetId))).next((()=>s.Pi.saveNamedQuery(i,t)))}))}/**
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
 */const Fd="firestore_clients";function ul(r,t){return`${Fd}_${r}_${t}`}const Md="firestore_mutations";function cl(r,t,e){let n=`${Md}_${r}_${e}`;return t.isAuthenticated()&&(n+=`_${t.uid}`),n}const Od="firestore_targets";function wo(r,t){return`${Od}_${r}_${t}`}/**
 * @license
 * Copyright 2018 Google LLC
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
 */const Yt="SharedClientState";class pi{constructor(t,e,n,s){this.user=t,this.batchId=e,this.state=n,this.error=s}static $s(t,e,n){const s=JSON.parse(n);let i,a=typeof s=="object"&&["pending","acknowledged","rejected"].indexOf(s.state)!==-1&&(s.error===void 0||typeof s.error=="object");return a&&s.error&&(a=typeof s.error.message=="string"&&typeof s.error.code=="string",a&&(i=new b(s.error.code,s.error.message))),a?new pi(t,e,s.state,i):(mt(Yt,`Failed to parse mutation state for ID '${e}': ${n}`),null)}Ws(){const t={state:this.state,updateTimeMs:Date.now()};return this.error&&(t.error={code:this.error.code,message:this.error.message}),JSON.stringify(t)}}class Hr{constructor(t,e,n){this.targetId=t,this.state=e,this.error=n}static $s(t,e){const n=JSON.parse(e);let s,i=typeof n=="object"&&["not-current","current","rejected"].indexOf(n.state)!==-1&&(n.error===void 0||typeof n.error=="object");return i&&n.error&&(i=typeof n.error.message=="string"&&typeof n.error.code=="string",i&&(s=new b(n.error.code,n.error.message))),i?new Hr(t,n.state,s):(mt(Yt,`Failed to parse target state for ID '${t}': ${e}`),null)}Ws(){const t={state:this.state,updateTimeMs:Date.now()};return this.error&&(t.error={code:this.error.code,message:this.error.message}),JSON.stringify(t)}}class _i{constructor(t,e){this.clientId=t,this.activeTargetIds=e}static $s(t,e){const n=JSON.parse(e);let s=typeof n=="object"&&n.activeTargetIds instanceof Array,i=fa();for(let a=0;s&&a<n.activeTargetIds.length;++a)s=nh(n.activeTargetIds[a]),i=i.add(n.activeTargetIds[a]);return s?new _i(t,i):(mt(Yt,`Failed to parse client data for instance '${t}': ${e}`),null)}}class ba{constructor(t,e){this.clientId=t,this.onlineState=e}static $s(t){const e=JSON.parse(t);return typeof e=="object"&&["Unknown","Online","Offline"].indexOf(e.onlineState)!==-1&&typeof e.clientId=="string"?new ba(e.clientId,e.onlineState):(mt(Yt,`Failed to parse online state: ${t}`),null)}}class Wo{constructor(){this.activeTargetIds=fa()}Qs(t){this.activeTargetIds=this.activeTargetIds.add(t)}Gs(t){this.activeTargetIds=this.activeTargetIds.delete(t)}Ws(){const t={activeTargetIds:this.activeTargetIds.toArray(),updateTimeMs:Date.now()};return JSON.stringify(t)}}class Ao{constructor(t,e,n,s,i){this.window=t,this.Ci=e,this.persistenceKey=n,this.zs=s,this.syncEngine=null,this.onlineStateHandler=null,this.sequenceNumberHandler=null,this.js=this.Hs.bind(this),this.Js=new it(z),this.started=!1,this.Zs=[];const a=n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");this.storage=this.window.localStorage,this.currentUser=i,this.Xs=ul(this.persistenceKey,this.zs),this.Ys=(function(c){return`firestore_sequence_number_${c}`})(this.persistenceKey),this.Js=this.Js.insert(this.zs,new Wo),this.eo=new RegExp(`^${Fd}_${a}_([^_]*)$`),this.no=new RegExp(`^${Md}_${a}_(\\d+)(?:_(.*))?$`),this.ro=new RegExp(`^${Od}_${a}_(\\d+)$`),this.io=(function(c){return`firestore_online_state_${c}`})(this.persistenceKey),this.so=(function(c){return`firestore_bundle_loaded_v2_${c}`})(this.persistenceKey),this.window.addEventListener("storage",this.js)}static v(t){return!(!t||!t.localStorage)}async start(){const t=await this.syncEngine.hs();for(const n of t){if(n===this.zs)continue;const s=this.getItem(ul(this.persistenceKey,n));if(s){const i=_i.$s(n,s);i&&(this.Js=this.Js.insert(i.clientId,i))}}this.oo();const e=this.storage.getItem(this.io);if(e){const n=this._o(e);n&&this.ao(n)}for(const n of this.Zs)this.Hs(n);this.Zs=[],this.window.addEventListener("pagehide",(()=>this.shutdown())),this.started=!0}writeSequenceNumber(t){this.setItem(this.Ys,JSON.stringify(t))}getAllActiveQueryTargets(){return this.uo(this.Js)}isActiveQueryTarget(t){let e=!1;return this.Js.forEach(((n,s)=>{s.activeTargetIds.has(t)&&(e=!0)})),e}addPendingMutation(t){this.co(t,"pending")}updateMutationState(t,e,n){this.co(t,e,n),this.lo(t)}addLocalQueryTarget(t,e=!0){let n="not-current";if(this.isActiveQueryTarget(t)){const s=this.storage.getItem(wo(this.persistenceKey,t));if(s){const i=Hr.$s(t,s);i&&(n=i.state)}}return e&&this.ho.Qs(t),this.oo(),n}removeLocalQueryTarget(t){this.ho.Gs(t),this.oo()}isLocalQueryTarget(t){return this.ho.activeTargetIds.has(t)}clearQueryState(t){this.removeItem(wo(this.persistenceKey,t))}updateQueryState(t,e,n){this.Po(t,e,n)}handleUserChange(t,e,n){e.forEach((s=>{this.lo(s)})),this.currentUser=t,n.forEach((s=>{this.addPendingMutation(s)}))}setOnlineState(t){this.To(t)}notifyBundleLoaded(t){this.Io(t)}shutdown(){this.started&&(this.window.removeEventListener("storage",this.js),this.removeItem(this.Xs),this.started=!1)}getItem(t){const e=this.storage.getItem(t);return x(Yt,"READ",t,e),e}setItem(t,e){x(Yt,"SET",t,e),this.storage.setItem(t,e)}removeItem(t){x(Yt,"REMOVE",t),this.storage.removeItem(t)}Hs(t){const e=t;if(e.storageArea===this.storage){if(x(Yt,"EVENT",e.key,e.newValue),e.key===this.Xs)return void mt("Received WebStorage notification for local change. Another client might have garbage-collected our state");this.Ci.enqueueRetryable((async()=>{if(this.started){if(e.key!==null){if(this.eo.test(e.key)){if(e.newValue==null){const n=this.Eo(e.key);return this.Ro(n,null)}{const n=this.Ao(e.key,e.newValue);if(n)return this.Ro(n.clientId,n)}}else if(this.no.test(e.key)){if(e.newValue!==null){const n=this.Vo(e.key,e.newValue);if(n)return this.mo(n)}}else if(this.ro.test(e.key)){if(e.newValue!==null){const n=this.fo(e.key,e.newValue);if(n)return this.po(n)}}else if(e.key===this.io){if(e.newValue!==null){const n=this._o(e.newValue);if(n)return this.ao(n)}}else if(e.key===this.Ys){const n=(function(i){let a=Mt.ce;if(i!=null)try{const u=JSON.parse(i);L(typeof u=="number",30636,{yo:i}),a=u}catch(u){mt(Yt,"Failed to read sequence number from WebStorage",u)}return a})(e.newValue);n!==Mt.ce&&this.sequenceNumberHandler(n)}else if(e.key===this.so){const n=this.wo(e.newValue);await Promise.all(n.map((s=>this.syncEngine.bo(s))))}}}else this.Zs.push(e)}))}}get ho(){return this.Js.get(this.zs)}oo(){this.setItem(this.Xs,this.ho.Ws())}co(t,e,n){const s=new pi(this.currentUser,t,e,n),i=cl(this.persistenceKey,this.currentUser,t);this.setItem(i,s.Ws())}lo(t){const e=cl(this.persistenceKey,this.currentUser,t);this.removeItem(e)}To(t){const e={clientId:this.zs,onlineState:t};this.storage.setItem(this.io,JSON.stringify(e))}Po(t,e,n){const s=wo(this.persistenceKey,t),i=new Hr(t,e,n);this.setItem(s,i.Ws())}Io(t){const e=JSON.stringify(Array.from(t));this.setItem(this.so,e)}Eo(t){const e=this.eo.exec(t);return e?e[1]:null}Ao(t,e){const n=this.Eo(t);return _i.$s(n,e)}Vo(t,e){const n=this.no.exec(t),s=Number(n[1]),i=n[2]!==void 0?n[2]:null;return pi.$s(new At(i),s,e)}fo(t,e){const n=this.ro.exec(t),s=Number(n[1]);return Hr.$s(s,e)}_o(t){return ba.$s(t)}wo(t){return JSON.parse(t)}async mo(t){if(t.user.uid===this.currentUser.uid)return this.syncEngine.So(t.batchId,t.state,t.error);x(Yt,`Ignoring mutation for non-active user ${t.user.uid}`)}po(t){return this.syncEngine.Do(t.targetId,t.state,t.error)}Ro(t,e){const n=e?this.Js.insert(t,e):this.Js.remove(t),s=this.uo(this.Js),i=this.uo(n),a=[],u=[];return i.forEach((c=>{s.has(c)||a.push(c)})),s.forEach((c=>{i.has(c)||u.push(c)})),this.syncEngine.Co(a,u).then((()=>{this.Js=n}))}ao(t){this.Js.get(t.clientId)&&this.onlineStateHandler(t.onlineState)}uo(t){let e=fa();return t.forEach(((n,s)=>{e=e.unionWith(s.activeTargetIds)})),e}}class Ld{constructor(){this.vo=new Wo,this.Fo={},this.onlineStateHandler=null,this.sequenceNumberHandler=null}addPendingMutation(t){}updateMutationState(t,e,n){}addLocalQueryTarget(t,e=!0){return e&&this.vo.Qs(t),this.Fo[t]||"not-current"}updateQueryState(t,e,n){this.Fo[t]=e}removeLocalQueryTarget(t){this.vo.Gs(t)}isLocalQueryTarget(t){return this.vo.activeTargetIds.has(t)}clearQueryState(t){delete this.Fo[t]}getAllActiveQueryTargets(){return this.vo.activeTargetIds}isActiveQueryTarget(t){return this.vo.activeTargetIds.has(t)}start(){return this.vo=new Wo,Promise.resolve()}handleUserChange(t,e,n){}setOnlineState(t){}shutdown(){}writeSequenceNumber(t){}notifyBundleLoaded(t){}}/**
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
 */class kp{Mo(t){}shutdown(){}}/**
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
 */const ll="ConnectivityMonitor";class hl{constructor(){this.xo=()=>this.Oo(),this.No=()=>this.Bo(),this.Lo=[],this.ko()}Mo(t){this.Lo.push(t)}shutdown(){window.removeEventListener("online",this.xo),window.removeEventListener("offline",this.No)}ko(){window.addEventListener("online",this.xo),window.addEventListener("offline",this.No)}Oo(){x(ll,"Network connectivity changed: AVAILABLE");for(const t of this.Lo)t(0)}Bo(){x(ll,"Network connectivity changed: UNAVAILABLE");for(const t of this.Lo)t(1)}static v(){return typeof window<"u"&&window.addEventListener!==void 0&&window.removeEventListener!==void 0}}/**
 * @license
 * Copyright 2023 Google LLC
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
 */let Ks=null;function Ho(){return Ks===null?Ks=(function(){return 268435456+Math.round(2147483648*Math.random())})():Ks++,"0x"+Ks.toString(16)}/**
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
 */const vo="RestConnection",Fp={BatchGetDocuments:"batchGet",Commit:"commit",RunQuery:"runQuery",RunAggregationQuery:"runAggregationQuery",ExecutePipeline:"executePipeline"};class Mp{get Ko(){return!1}constructor(t){this.databaseInfo=t,this.databaseId=t.databaseId;const e=t.ssl?"https":"http",n=encodeURIComponent(this.databaseId.projectId),s=encodeURIComponent(this.databaseId.database);this.qo=e+"://"+t.host,this.Uo=`projects/${n}/databases/${s}`,this.$o=this.databaseId.database===es?`project_id=${n}`:`project_id=${n}&database_id=${s}`}Wo(t,e,n,s,i){const a=Ho(),u=this.Qo(t,e.toUriEncodedString());x(vo,`Sending RPC '${t}' ${a}:`,u,n);const c={"google-cloud-resource-prefix":this.Uo,"x-goog-request-params":this.$o};this.Go(c,s,i);const{host:h}=new URL(u),f=Zo(h);return this.zo(t,u,c,n,f).then((m=>(x(vo,`Received RPC '${t}' ${a}: `,m),m)),(m=>{throw Gt(vo,`RPC '${t}' ${a} failed with error: `,m,"url: ",u,"request:",n),m}))}jo(t,e,n,s,i,a){return this.Wo(t,e,n,s,i)}Go(t,e,n){t["X-Goog-Api-Client"]=(function(){return"gl-js/ fire/"+sr})(),t["Content-Type"]="text/plain",this.databaseInfo.appId&&(t["X-Firebase-GMPID"]=this.databaseInfo.appId),e&&e.headers.forEach(((s,i)=>t[i]=s)),n&&n.headers.forEach(((s,i)=>t[i]=s))}Qo(t,e){const n=Fp[t];let s=`${this.qo}/v1/${e}:${n}`;return this.databaseInfo.apiKey&&(s=`${s}?key=${encodeURIComponent(this.databaseInfo.apiKey)}`),s}terminate(){}}/**
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
 */class Op{constructor(t){this.Ho=t.Ho,this.Jo=t.Jo}Zo(t){this.Xo=t}Yo(t){this.e_=t}t_(t){this.n_=t}onMessage(t){this.r_=t}close(){this.Jo()}send(t){this.Ho(t)}i_(){this.Xo()}s_(){this.e_()}o_(t){this.n_(t)}__(t){this.r_(t)}}/**
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
 */const bt="WebChannelConnection",Mr=(r,t,e)=>{r.listen(t,(n=>{try{e(n)}catch(s){setTimeout((()=>{throw s}),0)}}))};class Mn extends Mp{constructor(t){super(t),this.a_=[],this.forceLongPolling=t.forceLongPolling,this.autoDetectLongPolling=t.autoDetectLongPolling,this.useFetchStreams=t.useFetchStreams,this.longPollingOptions=t.longPollingOptions}static u_(){if(!Mn.c_){const t=Gl();Mr(t,zl.STAT_EVENT,(e=>{e.stat===Po.PROXY?x(bt,"STAT_EVENT: detected buffering proxy"):e.stat===Po.NOPROXY&&x(bt,"STAT_EVENT: detected no buffering proxy")})),Mn.c_=!0}}zo(t,e,n,s,i){const a=Ho();return new Promise(((u,c)=>{const h=new Ul;h.setWithCredentials(!0),h.listenOnce(jl.COMPLETE,(()=>{try{switch(h.getLastErrorCode()){case Qs.NO_ERROR:const m=h.getResponseJson();x(bt,`XHR for RPC '${t}' ${a} received:`,JSON.stringify(m)),u(m);break;case Qs.TIMEOUT:x(bt,`RPC '${t}' ${a} timed out`),c(new b(P.DEADLINE_EXCEEDED,"Request time out"));break;case Qs.HTTP_ERROR:const p=h.getStatus();if(x(bt,`RPC '${t}' ${a} failed with status:`,p,"response text:",h.getResponseText()),p>0){let v=h.getResponseJson();Array.isArray(v)&&(v=v[0]);const C=v==null?void 0:v.error;if(C&&C.status&&C.message){const N=(function(q){const j=q.toLowerCase().replace(/_/g,"-");return Object.values(P).indexOf(j)>=0?j:P.UNKNOWN})(C.status);c(new b(N,C.message))}else c(new b(P.UNKNOWN,"Server responded with status "+h.getStatus()))}else c(new b(P.UNAVAILABLE,"Connection failed."));break;default:O(9055,{l_:t,streamId:a,h_:h.getLastErrorCode(),P_:h.getLastError()})}}finally{x(bt,`RPC '${t}' ${a} completed.`)}}));const f=JSON.stringify(s);x(bt,`RPC '${t}' ${a} sending request:`,s),h.send(e,"POST",f,n,15)}))}T_(t,e,n){const s=Ho(),i=[this.qo,"/","google.firestore.v1.Firestore","/",t,"/channel"],a=this.createWebChannelTransport(),u={httpSessionIdParam:"gsessionid",initMessageHeaders:{},messageUrlParams:{database:`projects/${this.databaseId.projectId}/databases/${this.databaseId.database}`},sendRawJson:!0,supportsCrossDomainXhr:!0,internalChannelParams:{forwardChannelRequestTimeoutMs:6e5},forceLongPolling:this.forceLongPolling,detectBufferingProxy:this.autoDetectLongPolling},c=this.longPollingOptions.timeoutSeconds;c!==void 0&&(u.longPollingTimeout=Math.round(1e3*c)),this.useFetchStreams&&(u.useFetchStreams=!0),this.Go(u.initMessageHeaders,e,n),u.encodeInitMessageHeaders=!0;const h=i.join("");x(bt,`Creating RPC '${t}' stream ${s}: ${h}`,u);const f=a.createWebChannel(h,u);this.I_(f);let m=!1,p=!1;const v=new Op({Ho:C=>{p?x(bt,`Not sending because RPC '${t}' stream ${s} is closed:`,C):(m||(x(bt,`Opening RPC '${t}' stream ${s} transport.`),f.open(),m=!0),x(bt,`RPC '${t}' stream ${s} sending:`,C),f.send(C))},Jo:()=>f.close()});return Mr(f,Or.EventType.OPEN,(()=>{p||(x(bt,`RPC '${t}' stream ${s} transport opened.`),v.i_())})),Mr(f,Or.EventType.CLOSE,(()=>{p||(p=!0,x(bt,`RPC '${t}' stream ${s} transport closed`),v.o_(),this.E_(f))})),Mr(f,Or.EventType.ERROR,(C=>{p||(p=!0,Gt(bt,`RPC '${t}' stream ${s} transport errored. Name:`,C.name,"Message:",C.message),v.o_(new b(P.UNAVAILABLE,"The operation could not be completed")))})),Mr(f,Or.EventType.MESSAGE,(C=>{var N;if(!p){const D=C.data[0];L(!!D,16349);const q=D,j=(q==null?void 0:q.error)||((N=q[0])==null?void 0:N.error);if(j){x(bt,`RPC '${t}' stream ${s} received error:`,j);const U=j.status;let X=(function(T){const _=pt[T];if(_!==void 0)return Jh(_)})(U),J=j.message;U==="NOT_FOUND"&&J.includes("database")&&J.includes("does not exist")&&J.includes(this.databaseId.database)&&Gt(`Database '${this.databaseId.database}' not found. Please check your project configuration.`),X===void 0&&(X=P.INTERNAL,J="Unknown error status: "+U+" with message "+j.message),p=!0,v.o_(new b(X,J)),f.close()}else x(bt,`RPC '${t}' stream ${s} received:`,D),v.__(D)}})),Mn.u_(),setTimeout((()=>{v.s_()}),0),v}terminate(){this.a_.forEach((t=>t.close())),this.a_=[]}I_(t){this.a_.push(t)}E_(t){this.a_=this.a_.filter((e=>e===t))}Go(t,e,n){super.Go(t,e,n),this.databaseInfo.apiKey&&(t["x-goog-api-key"]=this.databaseInfo.apiKey)}createWebChannelTransport(){return Kl()}}/**
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
 */function Lp(r){return new Mn(r)}/**
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
 */function qd(){return typeof window<"u"?window:null}function ni(){return typeof document<"u"?document:null}/**
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
 */function yn(r){return new Gg(r,!0)}/**
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
 */Mn.c_=!1;class Ca{constructor(t,e,n=1e3,s=1.5,i=6e4){this.Ci=t,this.timerId=e,this.R_=n,this.A_=s,this.V_=i,this.d_=0,this.m_=null,this.f_=Date.now(),this.reset()}reset(){this.d_=0}g_(){this.d_=this.V_}p_(t){this.cancel();const e=Math.floor(this.d_+this.y_()),n=Math.max(0,Date.now()-this.f_),s=Math.max(0,e-n);s>0&&x("ExponentialBackoff",`Backing off for ${s} ms (base delay: ${this.d_} ms, delay with jitter: ${e} ms, last attempt: ${n} ms ago)`),this.m_=this.Ci.enqueueAfterDelay(this.timerId,s,(()=>(this.f_=Date.now(),t()))),this.d_*=this.A_,this.d_<this.R_&&(this.d_=this.R_),this.d_>this.V_&&(this.d_=this.V_)}w_(){this.m_!==null&&(this.m_.skipDelay(),this.m_=null)}cancel(){this.m_!==null&&(this.m_.cancel(),this.m_=null)}y_(){return(Math.random()-.5)*this.d_}}/**
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
 */const dl="PersistentStream";class Bd{constructor(t,e,n,s,i,a,u,c){this.Ci=t,this.b_=n,this.S_=s,this.connection=i,this.authCredentialsProvider=a,this.appCheckCredentialsProvider=u,this.listener=c,this.state=0,this.D_=0,this.C_=null,this.v_=null,this.stream=null,this.F_=0,this.M_=new Ca(t,e)}x_(){return this.state===1||this.state===5||this.O_()}O_(){return this.state===2||this.state===3}start(){this.F_=0,this.state!==4?this.auth():this.N_()}async stop(){this.x_()&&await this.close(0)}B_(){this.state=0,this.M_.reset()}L_(){this.O_()&&this.C_===null&&(this.C_=this.Ci.enqueueAfterDelay(this.b_,6e4,(()=>this.k_())))}K_(t){this.q_(),this.stream.send(t)}async k_(){if(this.O_())return this.close(0)}q_(){this.C_&&(this.C_.cancel(),this.C_=null)}U_(){this.v_&&(this.v_.cancel(),this.v_=null)}async close(t,e){this.q_(),this.U_(),this.M_.cancel(),this.D_++,t!==4?this.M_.reset():e&&e.code===P.RESOURCE_EXHAUSTED?(mt(e.toString()),mt("Using maximum backoff delay to prevent overloading the backend."),this.M_.g_()):e&&e.code===P.UNAUTHENTICATED&&this.state!==3&&(this.authCredentialsProvider.invalidateToken(),this.appCheckCredentialsProvider.invalidateToken()),this.stream!==null&&(this.W_(),this.stream.close(),this.stream=null),this.state=t,await this.listener.t_(e)}W_(){}auth(){this.state=1;const t=this.Q_(this.D_),e=this.D_;Promise.all([this.authCredentialsProvider.getToken(),this.appCheckCredentialsProvider.getToken()]).then((([n,s])=>{this.D_===e&&this.G_(n,s)}),(n=>{t((()=>{const s=new b(P.UNKNOWN,"Fetching auth token failed: "+n.message);return this.z_(s)}))}))}G_(t,e){const n=this.Q_(this.D_);this.stream=this.j_(t,e),this.stream.Zo((()=>{n((()=>this.listener.Zo()))})),this.stream.Yo((()=>{n((()=>(this.state=2,this.v_=this.Ci.enqueueAfterDelay(this.S_,1e4,(()=>(this.O_()&&(this.state=3),Promise.resolve()))),this.listener.Yo())))})),this.stream.t_((s=>{n((()=>this.z_(s)))})),this.stream.onMessage((s=>{n((()=>++this.F_==1?this.H_(s):this.onNext(s)))}))}N_(){this.state=5,this.M_.p_((async()=>{this.state=0,this.start()}))}z_(t){return x(dl,`close with error: ${t}`),this.stream=null,this.close(4,t)}Q_(t){return e=>{this.Ci.enqueueAndForget((()=>this.D_===t?e():(x(dl,"stream callback skipped by getCloseGuardedDispatcher."),Promise.resolve())))}}}class qp extends Bd{constructor(t,e,n,s,i,a){super(t,"listen_stream_connection_backoff","listen_stream_idle","health_check_timeout",e,n,s,a),this.serializer=i}j_(t,e){return this.connection.T_("Listen",t,e)}H_(t){return this.onNext(t)}onNext(t){this.M_.reset();const e=Qg(this.serializer,t),n=(function(i){if(!("targetChange"in i))return B.min();const a=i.targetChange;return a.targetIds&&a.targetIds.length?B.min():a.readTime?gt(a.readTime):B.min()})(t);return this.listener.J_(e,n)}Z_(t){const e={};e.database=zo(this.serializer),e.addTarget=(function(i,a){let u;const c=a.target;if(u=ui(c)?{documents:id(i,c)}:{query:xi(i,c).ft},u.targetId=a.targetId,a.resumeToken.approximateByteSize()>0){u.resumeToken=td(i,a.resumeToken);const h=Uo(i,a.expectedCount);h!==null&&(u.expectedCount=h)}else if(a.snapshotVersion.compareTo(B.min())>0){u.readTime=Yn(i,a.snapshotVersion.toTimestamp());const h=Uo(i,a.expectedCount);h!==null&&(u.expectedCount=h)}return u})(this.serializer,t);const n=Hg(this.serializer,t);n&&(e.labels=n),this.K_(e)}X_(t){const e={};e.database=zo(this.serializer),e.removeTarget=t,this.K_(e)}}class Bp extends Bd{constructor(t,e,n,s,i,a){super(t,"write_stream_connection_backoff","write_stream_idle","health_check_timeout",e,n,s,a),this.serializer=i}get Y_(){return this.F_>0}start(){this.lastStreamToken=void 0,super.start()}W_(){this.Y_&&this.ea([])}j_(t,e){return this.connection.T_("Write",t,e)}H_(t){return L(!!t.streamToken,31322),this.lastStreamToken=t.streamToken,L(!t.writeResults||t.writeResults.length===0,55816),this.listener.ta()}onNext(t){L(!!t.streamToken,12678),this.lastStreamToken=t.streamToken,this.M_.reset();const e=Wg(t.writeResults,t.commitTime),n=gt(t.commitTime);return this.listener.na(n,e)}ra(){const t={};t.database=zo(this.serializer),this.K_(t)}ea(t){const e={streamToken:this.lastStreamToken,writes:t.map((n=>os(this.serializer,n)))};this.K_(e)}}/**
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
 */class Up{}class jp extends Up{constructor(t,e,n,s){super(),this.authCredentials=t,this.appCheckCredentials=e,this.connection=n,this.serializer=s,this.ia=!1}sa(){if(this.ia)throw new b(P.FAILED_PRECONDITION,"The client has already been terminated.")}Wo(t,e,n,s){return this.sa(),Promise.all([this.authCredentials.getToken(),this.appCheckCredentials.getToken()]).then((([i,a])=>this.connection.Wo(t,jo(e,n),s,i,a))).catch((i=>{throw i.name==="FirebaseError"?(i.code===P.UNAUTHENTICATED&&(this.authCredentials.invalidateToken(),this.appCheckCredentials.invalidateToken()),i):new b(P.UNKNOWN,i.toString())}))}jo(t,e,n,s,i){return this.sa(),Promise.all([this.authCredentials.getToken(),this.appCheckCredentials.getToken()]).then((([a,u])=>this.connection.jo(t,jo(e,n),s,a,u,i))).catch((a=>{throw a.name==="FirebaseError"?(a.code===P.UNAUTHENTICATED&&(this.authCredentials.invalidateToken(),this.appCheckCredentials.invalidateToken()),a):new b(P.UNKNOWN,a.toString())}))}terminate(){this.ia=!0,this.connection.terminate()}}function zp(r,t,e,n){return new jp(r,t,e,n)}class Gp{constructor(t,e){this.asyncQueue=t,this.onlineStateHandler=e,this.state="Unknown",this.oa=0,this._a=null,this.aa=!0}ua(){this.oa===0&&(this.ca("Unknown"),this._a=this.asyncQueue.enqueueAfterDelay("online_state_timeout",1e4,(()=>(this._a=null,this.la("Backend didn't respond within 10 seconds."),this.ca("Offline"),Promise.resolve()))))}ha(t){this.state==="Online"?this.ca("Unknown"):(this.oa++,this.oa>=1&&(this.Pa(),this.la(`Connection failed 1 times. Most recent error: ${t.toString()}`),this.ca("Offline")))}set(t){this.Pa(),this.oa=0,t==="Online"&&(this.aa=!1),this.ca(t)}ca(t){t!==this.state&&(this.state=t,this.onlineStateHandler(t))}la(t){const e=`Could not reach Cloud Firestore backend. ${t}
This typically indicates that your device does not have a healthy Internet connection at the moment. The client will operate in offline mode until it is able to successfully connect to the backend.`;this.aa?(mt(e),this.aa=!1):x("OnlineStateTracker",e)}Pa(){this._a!==null&&(this._a.cancel(),this._a=null)}}/**
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
 */const gn="RemoteStore";class Kp{constructor(t,e,n,s,i){this.localStore=t,this.datastore=e,this.asyncQueue=n,this.remoteSyncer={},this.Ta=[],this.Ia=new Map,this.Ea=new Set,this.Ra=[],this.Aa=i,this.Aa.Mo((a=>{n.enqueueAndForget((async()=>{Be(this)&&(x(gn,"Restarting streams for network reachability change."),await(async function(c){const h=F(c);h.Ea.add(4),await ur(h),h.Va.set("Unknown"),h.Ea.delete(4),await ys(h)})(this))}))})),this.Va=new Gp(n,s)}}async function ys(r){if(Be(r))for(const t of r.Ra)await t(!0)}async function ur(r){for(const t of r.Ra)await t(!1)}function Mi(r,t){const e=F(r);e.Ia.has(t.targetId)||(e.Ia.set(t.targetId,t),Na(e)?Da(e):lr(e).O_()&&xa(e,t))}function tr(r,t){const e=F(r),n=lr(e);e.Ia.delete(t),n.O_()&&Ud(e,t),e.Ia.size===0&&(n.O_()?n.L_():Be(e)&&e.Va.set("Unknown"))}function xa(r,t){if(r.da.$e(t.targetId),t.resumeToken.approximateByteSize()>0||t.snapshotVersion.compareTo(B.min())>0){const e=r.remoteSyncer.getRemoteKeysForTarget(t.targetId).size;t=t.withExpectedCount(e)}lr(r).Z_(t)}function Ud(r,t){r.da.$e(t),lr(r).X_(t)}function Da(r){r.da=new Bg({getRemoteKeysForTarget:t=>r.remoteSyncer.getRemoteKeysForTarget(t),At:t=>r.Ia.get(t)||null,ht:()=>r.datastore.serializer.databaseId}),lr(r).start(),r.Va.ua()}function Na(r){return Be(r)&&!lr(r).x_()&&r.Ia.size>0}function Be(r){return F(r).Ea.size===0}function jd(r){r.da=void 0}async function $p(r){r.Va.set("Online")}async function Qp(r){r.Ia.forEach(((t,e)=>{xa(r,t)}))}async function Wp(r,t){jd(r),Na(r)?(r.Va.ha(t),Da(r)):r.Va.set("Unknown")}async function Hp(r,t,e){if(r.Va.set("Online"),t instanceof Zh&&t.state===2&&t.cause)try{await(async function(s,i){const a=i.cause;for(const u of i.targetIds)s.Ia.has(u)&&(await s.remoteSyncer.rejectListen(u,a),s.Ia.delete(u),s.da.removeTarget(u))})(r,t)}catch(n){x(gn,"Failed to remove targets %s: %s ",t.targetIds.join(","),n),await yi(r,n)}else if(t instanceof ti?r.da.Xe(t):t instanceof Xh?r.da.st(t):r.da.tt(t),!e.isEqual(B.min()))try{const n=await Cd(r.localStore);e.compareTo(n)>=0&&await(function(i,a){const u=i.da.Tt(a);return u.targetChanges.forEach(((c,h)=>{if(c.resumeToken.approximateByteSize()>0){const f=i.Ia.get(h);f&&i.Ia.set(h,f.withResumeToken(c.resumeToken,a))}})),u.targetMismatches.forEach(((c,h)=>{const f=i.Ia.get(c);if(!f)return;i.Ia.set(c,f.withResumeToken(ft.EMPTY_BYTE_STRING,f.snapshotVersion)),Ud(i,c);const m=new oe(f.target,c,h,f.sequenceNumber);xa(i,m)})),i.remoteSyncer.applyRemoteEvent(u)})(r,e)}catch(n){x(gn,"Failed to raise snapshot:",n),await yi(r,n)}}async function yi(r,t,e){if(!Le(t))throw t;r.Ea.add(1),await ur(r),r.Va.set("Offline"),e||(e=()=>Cd(r.localStore)),r.asyncQueue.enqueueRetryable((async()=>{x(gn,"Retrying IndexedDB access"),await e(),r.Ea.delete(1),await ys(r)}))}function zd(r,t){return t().catch((e=>yi(r,e,t)))}async function cr(r){const t=F(r),e=ke(t);let n=t.Ta.length>0?t.Ta[t.Ta.length-1].batchId:be;for(;Jp(t);)try{const s=await xp(t.localStore,n);if(s===null){t.Ta.length===0&&e.L_();break}n=s.batchId,Yp(t,s)}catch(s){await yi(t,s)}Gd(t)&&Kd(t)}function Jp(r){return Be(r)&&r.Ta.length<10}function Yp(r,t){r.Ta.push(t);const e=ke(r);e.O_()&&e.Y_&&e.ea(t.mutations)}function Gd(r){return Be(r)&&!ke(r).x_()&&r.Ta.length>0}function Kd(r){ke(r).start()}async function Xp(r){ke(r).ra()}async function Zp(r){const t=ke(r);for(const e of r.Ta)t.ea(e.mutations)}async function t_(r,t,e){const n=r.Ta.shift(),s=_a.from(n,t,e);await zd(r,(()=>r.remoteSyncer.applySuccessfulWrite(s))),await cr(r)}async function e_(r,t){t&&ke(r).Y_&&await(async function(n,s){if((function(a){return Hh(a)&&a!==P.ABORTED})(s.code)){const i=n.Ta.shift();ke(n).B_(),await zd(n,(()=>n.remoteSyncer.rejectFailedWrite(i.batchId,s))),await cr(n)}})(r,t),Gd(r)&&Kd(r)}async function fl(r,t){const e=F(r);e.asyncQueue.verifyOperationInProgress(),x(gn,"RemoteStore received new credentials");const n=Be(e);e.Ea.add(3),await ur(e),n&&e.Va.set("Unknown"),await e.remoteSyncer.handleCredentialChange(t),e.Ea.delete(3),await ys(e)}async function Jo(r,t){const e=F(r);t?(e.Ea.delete(2),await ys(e)):t||(e.Ea.add(2),await ur(e),e.Va.set("Unknown"))}function lr(r){return r.ma||(r.ma=(function(e,n,s){const i=F(e);return i.sa(),new qp(n,i.connection,i.authCredentials,i.appCheckCredentials,i.serializer,s)})(r.datastore,r.asyncQueue,{Zo:$p.bind(null,r),Yo:Qp.bind(null,r),t_:Wp.bind(null,r),J_:Hp.bind(null,r)}),r.Ra.push((async t=>{t?(r.ma.B_(),Na(r)?Da(r):r.Va.set("Unknown")):(await r.ma.stop(),jd(r))}))),r.ma}function ke(r){return r.fa||(r.fa=(function(e,n,s){const i=F(e);return i.sa(),new Bp(n,i.connection,i.authCredentials,i.appCheckCredentials,i.serializer,s)})(r.datastore,r.asyncQueue,{Zo:()=>Promise.resolve(),Yo:Xp.bind(null,r),t_:e_.bind(null,r),ta:Zp.bind(null,r),na:t_.bind(null,r)}),r.Ra.push((async t=>{t?(r.fa.B_(),await cr(r)):(await r.fa.stop(),r.Ta.length>0&&(x(gn,`Stopping write stream with ${r.Ta.length} pending writes`),r.Ta=[]))}))),r.fa}/**
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
 */class ka{constructor(t,e,n,s,i){this.asyncQueue=t,this.timerId=e,this.targetTimeMs=n,this.op=s,this.removalCallback=i,this.deferred=new Rt,this.then=this.deferred.promise.then.bind(this.deferred.promise),this.deferred.promise.catch((a=>{}))}get promise(){return this.deferred.promise}static createAndSchedule(t,e,n,s,i){const a=Date.now()+n,u=new ka(t,e,a,s,i);return u.start(n),u}start(t){this.timerHandle=setTimeout((()=>this.handleDelayElapsed()),t)}skipDelay(){return this.handleDelayElapsed()}cancel(t){this.timerHandle!==null&&(this.clearTimeout(),this.deferred.reject(new b(P.CANCELLED,"Operation cancelled"+(t?": "+t:""))))}handleDelayElapsed(){this.asyncQueue.enqueueAndForget((()=>this.timerHandle!==null?(this.clearTimeout(),this.op().then((t=>this.deferred.resolve(t)))):Promise.resolve()))}clearTimeout(){this.timerHandle!==null&&(this.removalCallback(this),clearTimeout(this.timerHandle),this.timerHandle=null)}}function hr(r,t){if(mt("AsyncQueue",`${t}: ${r}`),Le(r))return new b(P.UNAVAILABLE,`${t}: ${r}`);throw r}/**
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
 */class on{static emptySet(t){return new on(t.comparator)}constructor(t){this.comparator=t?(e,n)=>t(e,n)||k.comparator(e.key,n.key):(e,n)=>k.comparator(e.key,n.key),this.keyedMap=Lr(),this.sortedSet=new it(this.comparator)}has(t){return this.keyedMap.get(t)!=null}get(t){return this.keyedMap.get(t)}first(){return this.sortedSet.minKey()}last(){return this.sortedSet.maxKey()}isEmpty(){return this.sortedSet.isEmpty()}indexOf(t){const e=this.keyedMap.get(t);return e?this.sortedSet.indexOf(e):-1}get size(){return this.sortedSet.size}forEach(t){this.sortedSet.inorderTraversal(((e,n)=>(t(e),!1)))}add(t){const e=this.delete(t.key);return e.copy(e.keyedMap.insert(t.key,t),e.sortedSet.insert(t,null))}delete(t){const e=this.get(t);return e?this.copy(this.keyedMap.remove(t),this.sortedSet.remove(e)):this}isEqual(t){if(!(t instanceof on)||this.size!==t.size)return!1;const e=this.sortedSet.getIterator(),n=t.sortedSet.getIterator();for(;e.hasNext();){const s=e.getNext().key,i=n.getNext().key;if(!s.isEqual(i))return!1}return!0}toString(){const t=[];return this.forEach((e=>{t.push(e.toString())})),t.length===0?"DocumentSet ()":`DocumentSet (
  `+t.join(`  
`)+`
)`}copy(t,e){const n=new on;return n.comparator=this.comparator,n.keyedMap=t,n.sortedSet=e,n}}/**
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
 */class ml{constructor(){this.ga=new it(k.comparator)}track(t){const e=t.doc.key,n=this.ga.get(e);n?t.type!==0&&n.type===3?this.ga=this.ga.insert(e,t):t.type===3&&n.type!==1?this.ga=this.ga.insert(e,{type:n.type,doc:t.doc}):t.type===2&&n.type===2?this.ga=this.ga.insert(e,{type:2,doc:t.doc}):t.type===2&&n.type===0?this.ga=this.ga.insert(e,{type:0,doc:t.doc}):t.type===1&&n.type===0?this.ga=this.ga.remove(e):t.type===1&&n.type===2?this.ga=this.ga.insert(e,{type:1,doc:n.doc}):t.type===0&&n.type===1?this.ga=this.ga.insert(e,{type:2,doc:t.doc}):O(63341,{Vt:t,pa:n}):this.ga=this.ga.insert(e,t)}ya(){const t=[];return this.ga.inorderTraversal(((e,n)=>{t.push(n)})),t}}class pn{constructor(t,e,n,s,i,a,u,c,h){this.query=t,this.docs=e,this.oldDocs=n,this.docChanges=s,this.mutatedKeys=i,this.fromCache=a,this.syncStateChanged=u,this.excludesMetadataChanges=c,this.hasCachedResults=h}static fromInitialDocuments(t,e,n,s,i){const a=[];return e.forEach((u=>{a.push({type:0,doc:u})})),new pn(t,e,on.emptySet(e),a,n,s,!0,!1,i)}get hasPendingWrites(){return!this.mutatedKeys.isEmpty()}isEqual(t){if(!(this.fromCache===t.fromCache&&this.hasCachedResults===t.hasCachedResults&&this.syncStateChanged===t.syncStateChanged&&this.mutatedKeys.isEqual(t.mutatedKeys)&&fs(this.query,t.query)&&this.docs.isEqual(t.docs)&&this.oldDocs.isEqual(t.oldDocs)))return!1;const e=this.docChanges,n=t.docChanges;if(e.length!==n.length)return!1;for(let s=0;s<e.length;s++)if(e[s].type!==n[s].type||!e[s].doc.isEqual(n[s].doc))return!1;return!0}}/**
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
 */class n_{constructor(){this.wa=void 0,this.ba=[]}Sa(){return this.ba.some((t=>t.Da()))}}class r_{constructor(){this.queries=gl(),this.onlineState="Unknown",this.Ca=new Set}terminate(){(function(e,n){const s=F(e),i=s.queries;s.queries=gl(),i.forEach(((a,u)=>{for(const c of u.ba)c.onError(n)}))})(this,new b(P.ABORTED,"Firestore shutting down"))}}function gl(){return new he((r=>kh(r)),fs)}async function Fa(r,t){const e=F(r);let n=3;const s=t.query;let i=e.queries.get(s);i?!i.Sa()&&t.Da()&&(n=2):(i=new n_,n=t.Da()?0:1);try{switch(n){case 0:i.wa=await e.onListen(s,!0);break;case 1:i.wa=await e.onListen(s,!1);break;case 2:await e.onFirstRemoteStoreListen(s)}}catch(a){const u=hr(a,`Initialization of query '${Dn(t.query)}' failed`);return void t.onError(u)}e.queries.set(s,i),i.ba.push(t),t.va(e.onlineState),i.wa&&t.Fa(i.wa)&&Oa(e)}async function Ma(r,t){const e=F(r),n=t.query;let s=3;const i=e.queries.get(n);if(i){const a=i.ba.indexOf(t);a>=0&&(i.ba.splice(a,1),i.ba.length===0?s=t.Da()?0:1:!i.Sa()&&t.Da()&&(s=2))}switch(s){case 0:return e.queries.delete(n),e.onUnlisten(n,!0);case 1:return e.queries.delete(n),e.onUnlisten(n,!1);case 2:return e.onLastRemoteStoreUnlisten(n);default:return}}function s_(r,t){const e=F(r);let n=!1;for(const s of t){const i=s.query,a=e.queries.get(i);if(a){for(const u of a.ba)u.Fa(s)&&(n=!0);a.wa=s}}n&&Oa(e)}function i_(r,t,e){const n=F(r),s=n.queries.get(t);if(s)for(const i of s.ba)i.onError(e);n.queries.delete(t)}function Oa(r){r.Ca.forEach((t=>{t.next()}))}var Yo,pl;(pl=Yo||(Yo={})).Ma="default",pl.Cache="cache";class La{constructor(t,e,n){this.query=t,this.xa=e,this.Oa=!1,this.Na=null,this.onlineState="Unknown",this.options=n||{}}Fa(t){if(!this.options.includeMetadataChanges){const n=[];for(const s of t.docChanges)s.type!==3&&n.push(s);t=new pn(t.query,t.docs,t.oldDocs,n,t.mutatedKeys,t.fromCache,t.syncStateChanged,!0,t.hasCachedResults)}let e=!1;return this.Oa?this.Ba(t)&&(this.xa.next(t),e=!0):this.La(t,this.onlineState)&&(this.ka(t),e=!0),this.Na=t,e}onError(t){this.xa.error(t)}va(t){this.onlineState=t;let e=!1;return this.Na&&!this.Oa&&this.La(this.Na,t)&&(this.ka(this.Na),e=!0),e}La(t,e){if(!t.fromCache||!this.Da())return!0;const n=e!=="Offline";return(!this.options.Ka||!n)&&(!t.docs.isEmpty()||t.hasCachedResults||e==="Offline")}Ba(t){if(t.docChanges.length>0)return!0;const e=this.Na&&this.Na.hasPendingWrites!==t.hasPendingWrites;return!(!t.syncStateChanged&&!e)&&this.options.includeMetadataChanges===!0}ka(t){t=pn.fromInitialDocuments(t.query,t.docs,t.mutatedKeys,t.fromCache,t.hasCachedResults),this.Oa=!0,this.xa.next(t)}Da(){return this.options.source!==Yo.Cache}}/**
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
 */class $d{constructor(t,e){this.qa=t,this.byteLength=e}Ua(){return"metadata"in this.qa}}/**
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
 */class _l{constructor(t){this.serializer=t}Ks(t){return ee(this.serializer,t)}qs(t){return t.metadata.exists?Ci(this.serializer,t.document,!1):at.newNoDocument(this.Ks(t.metadata.name),this.Us(t.metadata.readTime))}Us(t){return gt(t)}}class qa{constructor(t,e){this.$a=t,this.serializer=e,this.Wa=[],this.Qa=[],this.collectionGroups=new Set,this.progress=Qd(t)}get queries(){return this.Wa}get documents(){return this.Qa}Ga(t){this.progress.bytesLoaded+=t.byteLength;let e=this.progress.documentsLoaded;if(t.qa.namedQuery)this.Wa.push(t.qa.namedQuery);else if(t.qa.documentMetadata){this.Qa.push({metadata:t.qa.documentMetadata}),t.qa.documentMetadata.exists||++e;const n=$.fromString(t.qa.documentMetadata.name);this.collectionGroups.add(n.get(n.length-2))}else t.qa.document&&(this.Qa[this.Qa.length-1].document=t.qa.document,++e);return e!==this.progress.documentsLoaded?(this.progress.documentsLoaded=e,{...this.progress}):null}za(t){const e=new Map,n=new _l(this.serializer);for(const s of t)if(s.metadata.queries){const i=n.Ks(s.metadata.name);for(const a of s.metadata.queries){const u=(e.get(a)||G()).add(i);e.set(a,u)}}return e}async ja(t){const e=await Dp(t,new _l(this.serializer),this.Qa,this.$a.id),n=this.za(this.documents);for(const s of this.Wa)await Np(t,s,n.get(s.name));return this.progress.taskState="Success",{progress:this.progress,Ha:this.collectionGroups,Ja:e}}}function Qd(r){return{taskState:"Running",documentsLoaded:0,bytesLoaded:0,totalDocuments:r.totalDocuments,totalBytes:r.totalBytes}}/**
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
 */class Wd{constructor(t){this.key=t}}class Hd{constructor(t){this.key=t}}class Jd{constructor(t,e){this.query=t,this.Za=e,this.Xa=null,this.hasCachedResults=!1,this.current=!1,this.Ya=G(),this.mutatedKeys=G(),this.eu=Mh(t),this.tu=new on(this.eu)}get nu(){return this.Za}ru(t,e){const n=e?e.iu:new ml,s=e?e.tu:this.tu;let i=e?e.mutatedKeys:this.mutatedKeys,a=s,u=!1;const c=this.query.limitType==="F"&&s.size===this.query.limit?s.last():null,h=this.query.limitType==="L"&&s.size===this.query.limit?s.first():null;if(t.inorderTraversal(((f,m)=>{const p=s.get(f),v=ms(this.query,m)?m:null,C=!!p&&this.mutatedKeys.has(p.key),N=!!v&&(v.hasLocalMutations||this.mutatedKeys.has(v.key)&&v.hasCommittedMutations);let D=!1;p&&v?p.data.isEqual(v.data)?C!==N&&(n.track({type:3,doc:v}),D=!0):this.su(p,v)||(n.track({type:2,doc:v}),D=!0,(c&&this.eu(v,c)>0||h&&this.eu(v,h)<0)&&(u=!0)):!p&&v?(n.track({type:0,doc:v}),D=!0):p&&!v&&(n.track({type:1,doc:p}),D=!0,(c||h)&&(u=!0)),D&&(v?(a=a.add(v),i=N?i.add(f):i.delete(f)):(a=a.delete(f),i=i.delete(f)))})),this.query.limit!==null)for(;a.size>this.query.limit;){const f=this.query.limitType==="F"?a.last():a.first();a=a.delete(f.key),i=i.delete(f.key),n.track({type:1,doc:f})}return{tu:a,iu:n,Ss:u,mutatedKeys:i}}su(t,e){return t.hasLocalMutations&&e.hasCommittedMutations&&!e.hasLocalMutations}applyChanges(t,e,n,s){const i=this.tu;this.tu=t.tu,this.mutatedKeys=t.mutatedKeys;const a=t.iu.ya();a.sort(((f,m)=>(function(v,C){const N=D=>{switch(D){case 0:return 1;case 2:case 3:return 2;case 1:return 0;default:return O(20277,{Vt:D})}};return N(v)-N(C)})(f.type,m.type)||this.eu(f.doc,m.doc))),this.ou(n),s=s??!1;const u=e&&!s?this._u():[],c=this.Ya.size===0&&this.current&&!s?1:0,h=c!==this.Xa;return this.Xa=c,a.length!==0||h?{snapshot:new pn(this.query,t.tu,i,a,t.mutatedKeys,c===0,h,!1,!!n&&n.resumeToken.approximateByteSize()>0),au:u}:{au:u}}va(t){return this.current&&t==="Offline"?(this.current=!1,this.applyChanges({tu:this.tu,iu:new ml,mutatedKeys:this.mutatedKeys,Ss:!1},!1)):{au:[]}}uu(t){return!this.Za.has(t)&&!!this.tu.has(t)&&!this.tu.get(t).hasLocalMutations}ou(t){t&&(t.addedDocuments.forEach((e=>this.Za=this.Za.add(e))),t.modifiedDocuments.forEach((e=>{})),t.removedDocuments.forEach((e=>this.Za=this.Za.delete(e))),this.current=t.current)}_u(){if(!this.current)return[];const t=this.Ya;this.Ya=G(),this.tu.forEach((n=>{this.uu(n.key)&&(this.Ya=this.Ya.add(n.key))}));const e=[];return t.forEach((n=>{this.Ya.has(n)||e.push(new Hd(n))})),this.Ya.forEach((n=>{t.has(n)||e.push(new Wd(n))})),e}cu(t){this.Za=t.ks,this.Ya=G();const e=this.ru(t.documents);return this.applyChanges(e,!0)}lu(){return pn.fromInitialDocuments(this.query,this.tu,this.mutatedKeys,this.Xa===0,this.hasCachedResults)}}const Ue="SyncEngine";class o_{constructor(t,e,n){this.query=t,this.targetId=e,this.view=n}}class a_{constructor(t){this.key=t,this.hu=!1}}class u_{constructor(t,e,n,s,i,a){this.localStore=t,this.remoteStore=e,this.eventManager=n,this.sharedClientState=s,this.currentUser=i,this.maxConcurrentLimboResolutions=a,this.Pu={},this.Tu=new he((u=>kh(u)),fs),this.Iu=new Map,this.Eu=new Set,this.Ru=new it(k.comparator),this.Au=new Map,this.Vu=new Aa,this.du={},this.mu=new Map,this.fu=mn.ar(),this.onlineState="Unknown",this.gu=void 0}get isPrimaryClient(){return this.gu===!0}}async function c_(r,t,e=!0){const n=Oi(r);let s;const i=n.Tu.get(t);return i?(n.sharedClientState.addLocalQueryTarget(i.targetId),s=i.view.lu()):s=await Yd(n,t,e,!0),s}async function l_(r,t){const e=Oi(r);await Yd(e,t,!0,!1)}async function Yd(r,t,e,n){const s=await Xn(r.localStore,Dt(t)),i=s.targetId,a=r.sharedClientState.addLocalQueryTarget(i,e);let u;return n&&(u=await Ba(r,t,i,a==="current",s.resumeToken)),r.isPrimaryClient&&e&&Mi(r.remoteStore,s),u}async function Ba(r,t,e,n,s){r.pu=(m,p,v)=>(async function(N,D,q,j){let U=D.view.ru(q);U.Ss&&(U=await gi(N.localStore,D.query,!1).then((({documents:T})=>D.view.ru(T,U))));const X=j&&j.targetChanges.get(D.targetId),J=j&&j.targetMismatches.get(D.targetId)!=null,Y=D.view.applyChanges(U,N.isPrimaryClient,X,J);return Xo(N,D.targetId,Y.au),Y.snapshot})(r,m,p,v);const i=await gi(r.localStore,t,!0),a=new Jd(t,i.ks),u=a.ru(i.documents),c=_s.createSynthesizedTargetChangeForCurrentChange(e,n&&r.onlineState!=="Offline",s),h=a.applyChanges(u,r.isPrimaryClient,c);Xo(r,e,h.au);const f=new o_(t,e,a);return r.Tu.set(t,f),r.Iu.has(e)?r.Iu.get(e).push(t):r.Iu.set(e,[t]),h.snapshot}async function h_(r,t,e){const n=F(r),s=n.Tu.get(t),i=n.Iu.get(s.targetId);if(i.length>1)return n.Iu.set(s.targetId,i.filter((a=>!fs(a,t)))),void n.Tu.delete(t);n.isPrimaryClient?(n.sharedClientState.removeLocalQueryTarget(s.targetId),n.sharedClientState.isActiveQueryTarget(s.targetId)||await Zn(n.localStore,s.targetId,!1).then((()=>{n.sharedClientState.clearQueryState(s.targetId),e&&tr(n.remoteStore,s.targetId),er(n,s.targetId)})).catch(Oe)):(er(n,s.targetId),await Zn(n.localStore,s.targetId,!0))}async function d_(r,t){const e=F(r),n=e.Tu.get(t),s=e.Iu.get(n.targetId);e.isPrimaryClient&&s.length===1&&(e.sharedClientState.removeLocalQueryTarget(n.targetId),tr(e.remoteStore,n.targetId))}async function f_(r,t,e){const n=Ga(r);try{const s=await(function(a,u){const c=F(a),h=Z.now(),f=u.reduce(((v,C)=>v.add(C.key)),G());let m,p;return c.persistence.runTransaction("Locally write mutations","readwrite",(v=>{let C=Lt(),N=G();return c.xs.getEntries(v,f).next((D=>{C=D,C.forEach(((q,j)=>{j.isValidDocument()||(N=N.add(q))}))})).next((()=>c.localDocuments.getOverlayedDocuments(v,C))).next((D=>{m=D;const q=[];for(const j of u){const U=Mg(j,m.get(j.key).overlayedDocument);U!=null&&q.push(new de(j.key,U,Ah(U.value.mapValue),lt.exists(!0)))}return c.mutationQueue.addMutationBatch(v,h,q,u)})).next((D=>{p=D;const q=D.applyToLocalDocumentSet(m,N);return c.documentOverlayCache.saveOverlays(v,D.batchId,q)}))})).then((()=>({batchId:p.batchId,changes:Lh(m)})))})(n.localStore,t);n.sharedClientState.addPendingMutation(s.batchId),(function(a,u,c){let h=a.du[a.currentUser.toKey()];h||(h=new it(z)),h=h.insert(u,c),a.du[a.currentUser.toKey()]=h})(n,s.batchId,e),await fe(n,s.changes),await cr(n.remoteStore)}catch(s){const i=hr(s,"Failed to persist write");e.reject(i)}}async function Xd(r,t){const e=F(r);try{const n=await Cp(e.localStore,t);t.targetChanges.forEach(((s,i)=>{const a=e.Au.get(i);a&&(L(s.addedDocuments.size+s.modifiedDocuments.size+s.removedDocuments.size<=1,22616),s.addedDocuments.size>0?a.hu=!0:s.modifiedDocuments.size>0?L(a.hu,14607):s.removedDocuments.size>0&&(L(a.hu,42227),a.hu=!1))})),await fe(e,n,t)}catch(n){await Oe(n)}}function yl(r,t,e){const n=F(r);if(n.isPrimaryClient&&e===0||!n.isPrimaryClient&&e===1){const s=[];n.Tu.forEach(((i,a)=>{const u=a.view.va(t);u.snapshot&&s.push(u.snapshot)})),(function(a,u){const c=F(a);c.onlineState=u;let h=!1;c.queries.forEach(((f,m)=>{for(const p of m.ba)p.va(u)&&(h=!0)})),h&&Oa(c)})(n.eventManager,t),s.length&&n.Pu.J_(s),n.onlineState=t,n.isPrimaryClient&&n.sharedClientState.setOnlineState(t)}}async function m_(r,t,e){const n=F(r);n.sharedClientState.updateQueryState(t,"rejected",e);const s=n.Au.get(t),i=s&&s.key;if(i){let a=new it(k.comparator);a=a.insert(i,at.newNoDocument(i,B.min()));const u=G().add(i),c=new ps(B.min(),new Map,new it(z),a,u);await Xd(n,c),n.Ru=n.Ru.remove(i),n.Au.delete(t),za(n)}else await Zn(n.localStore,t,!1).then((()=>er(n,t,e))).catch(Oe)}async function g_(r,t){const e=F(r),n=t.batch.batchId;try{const s=await bp(e.localStore,t);ja(e,n,null),Ua(e,n),e.sharedClientState.updateMutationState(n,"acknowledged"),await fe(e,s)}catch(s){await Oe(s)}}async function p_(r,t,e){const n=F(r);try{const s=await(function(a,u){const c=F(a);return c.persistence.runTransaction("Reject batch","readwrite-primary",(h=>{let f;return c.mutationQueue.lookupMutationBatch(h,u).next((m=>(L(m!==null,37113),f=m.keys(),c.mutationQueue.removeMutationBatch(h,m)))).next((()=>c.mutationQueue.performConsistencyCheck(h))).next((()=>c.documentOverlayCache.removeOverlaysForBatchId(h,f,u))).next((()=>c.localDocuments.recalculateAndSaveOverlaysForDocumentKeys(h,f))).next((()=>c.localDocuments.getDocuments(h,f)))}))})(n.localStore,t);ja(n,t,e),Ua(n,t),n.sharedClientState.updateMutationState(t,"rejected",e),await fe(n,s)}catch(s){await Oe(s)}}async function __(r,t){const e=F(r);Be(e.remoteStore)||x(Ue,"The network is disabled. The task returned by 'awaitPendingWrites()' will not complete until the network is enabled.");try{const n=await(function(a){const u=F(a);return u.persistence.runTransaction("Get highest unacknowledged batch id","readonly",(c=>u.mutationQueue.getHighestUnacknowledgedBatchId(c)))})(e.localStore);if(n===be)return void t.resolve();const s=e.mu.get(n)||[];s.push(t),e.mu.set(n,s)}catch(n){const s=hr(n,"Initialization of waitForPendingWrites() operation failed");t.reject(s)}}function Ua(r,t){(r.mu.get(t)||[]).forEach((e=>{e.resolve()})),r.mu.delete(t)}function ja(r,t,e){const n=F(r);let s=n.du[n.currentUser.toKey()];if(s){const i=s.get(t);i&&(e?i.reject(e):i.resolve(),s=s.remove(t)),n.du[n.currentUser.toKey()]=s}}function er(r,t,e=null){r.sharedClientState.removeLocalQueryTarget(t);for(const n of r.Iu.get(t))r.Tu.delete(n),e&&r.Pu.yu(n,e);r.Iu.delete(t),r.isPrimaryClient&&r.Vu.Gr(t).forEach((n=>{r.Vu.containsKey(n)||Zd(r,n)}))}function Zd(r,t){r.Eu.delete(t.path.canonicalString());const e=r.Ru.get(t);e!==null&&(tr(r.remoteStore,e),r.Ru=r.Ru.remove(t),r.Au.delete(e),za(r))}function Xo(r,t,e){for(const n of e)n instanceof Wd?(r.Vu.addReference(n.key,t),y_(r,n)):n instanceof Hd?(x(Ue,"Document no longer in limbo: "+n.key),r.Vu.removeReference(n.key,t),r.Vu.containsKey(n.key)||Zd(r,n.key)):O(19791,{wu:n})}function y_(r,t){const e=t.key,n=e.path.canonicalString();r.Ru.get(e)||r.Eu.has(n)||(x(Ue,"New document in limbo: "+e),r.Eu.add(n),za(r))}function za(r){for(;r.Eu.size>0&&r.Ru.size<r.maxConcurrentLimboResolutions;){const t=r.Eu.values().next().value;r.Eu.delete(t);const e=new k($.fromString(t)),n=r.fu.next();r.Au.set(n,new a_(e)),r.Ru=r.Ru.insert(e,n),Mi(r.remoteStore,new oe(Dt(ir(e.path)),n,"TargetPurposeLimboResolution",Mt.ce))}}async function fe(r,t,e){const n=F(r),s=[],i=[],a=[];n.Tu.isEmpty()||(n.Tu.forEach(((u,c)=>{a.push(n.pu(c,t,e).then((h=>{var f;if((h||e)&&n.isPrimaryClient){const m=h?!h.fromCache:(f=e==null?void 0:e.targetChanges.get(c.targetId))==null?void 0:f.current;n.sharedClientState.updateQueryState(c.targetId,m?"current":"not-current")}if(h){s.push(h);const m=Sa.Es(c.targetId,h);i.push(m)}})))})),await Promise.all(a),n.Pu.J_(s),await(async function(c,h){const f=F(c);try{await f.persistence.runTransaction("notifyLocalViewChanges","readwrite",(m=>A.forEach(h,(p=>A.forEach(p.Ts,(v=>f.persistence.referenceDelegate.addReference(m,p.targetId,v))).next((()=>A.forEach(p.Is,(v=>f.persistence.referenceDelegate.removeReference(m,p.targetId,v)))))))))}catch(m){if(!Le(m))throw m;x(Va,"Failed to update sequence numbers: "+m)}for(const m of h){const p=m.targetId;if(!m.fromCache){const v=f.vs.get(p),C=v.snapshotVersion,N=v.withLastLimboFreeSnapshotVersion(C);f.vs=f.vs.insert(p,N)}}})(n.localStore,i))}async function I_(r,t){const e=F(r);if(!e.currentUser.isEqual(t)){x(Ue,"User change. New user:",t.toKey());const n=await bd(e.localStore,t);e.currentUser=t,(function(i,a){i.mu.forEach((u=>{u.forEach((c=>{c.reject(new b(P.CANCELLED,a))}))})),i.mu.clear()})(e,"'waitForPendingWrites' promise is rejected due to a user change."),e.sharedClientState.handleUserChange(t,n.removedBatchIds,n.addedBatchIds),await fe(e,n.Ns)}}function T_(r,t){const e=F(r),n=e.Au.get(t);if(n&&n.hu)return G().add(n.key);{let s=G();const i=e.Iu.get(t);if(!i)return s;for(const a of i){const u=e.Tu.get(a);s=s.unionWith(u.view.nu)}return s}}async function E_(r,t){const e=F(r),n=await gi(e.localStore,t.query,!0),s=t.view.cu(n);return e.isPrimaryClient&&Xo(e,t.targetId,s.au),s}async function w_(r,t){const e=F(r);return Nd(e.localStore,t).then((n=>fe(e,n)))}async function A_(r,t,e,n){const s=F(r),i=await(function(u,c){const h=F(u),f=F(h.mutationQueue);return h.persistence.runTransaction("Lookup mutation documents","readonly",(m=>f.Xn(m,c).next((p=>p?h.localDocuments.getDocuments(m,p):A.resolve(null)))))})(s.localStore,t);i!==null?(e==="pending"?await cr(s.remoteStore):e==="acknowledged"||e==="rejected"?(ja(s,t,n||null),Ua(s,t),(function(u,c){F(F(u).mutationQueue).nr(c)})(s.localStore,t)):O(6720,"Unknown batchState",{bu:e}),await fe(s,i)):x(Ue,"Cannot apply mutation batch with id: "+t)}async function v_(r,t){const e=F(r);if(Oi(e),Ga(e),t===!0&&e.gu!==!0){const n=e.sharedClientState.getAllActiveQueryTargets(),s=await Il(e,n.toArray());e.gu=!0,await Jo(e.remoteStore,!0);for(const i of s)Mi(e.remoteStore,i)}else if(t===!1&&e.gu!==!1){const n=[];let s=Promise.resolve();e.Iu.forEach(((i,a)=>{e.sharedClientState.isLocalQueryTarget(a)?n.push(a):s=s.then((()=>(er(e,a),Zn(e.localStore,a,!0)))),tr(e.remoteStore,a)})),await s,await Il(e,n),(function(a){const u=F(a);u.Au.forEach(((c,h)=>{tr(u.remoteStore,h)})),u.Vu.zr(),u.Au=new Map,u.Ru=new it(k.comparator)})(e),e.gu=!1,await Jo(e.remoteStore,!1)}}async function Il(r,t,e){const n=F(r),s=[],i=[];for(const a of t){let u;const c=n.Iu.get(a);if(c&&c.length!==0){u=await Xn(n.localStore,Dt(c[0]));for(const h of c){const f=n.Tu.get(h),m=await E_(n,f);m.snapshot&&i.push(m.snapshot)}}else{const h=await Dd(n.localStore,a);u=await Xn(n.localStore,h),await Ba(n,tf(h),a,!1,u.resumeToken)}s.push(u)}return n.Pu.J_(i),s}function tf(r){return xh(r.path,r.collectionGroup,r.orderBy,r.filters,r.limit,"F",r.startAt,r.endAt)}function R_(r){return(function(e){return F(F(e).persistence).hs()})(F(r).localStore)}async function P_(r,t,e,n){const s=F(r);if(s.gu)return void x(Ue,"Ignoring unexpected query state notification.");const i=s.Iu.get(t);if(i&&i.length>0)switch(e){case"current":case"not-current":{const a=await Nd(s.localStore,Fh(i[0])),u=ps.createSynthesizedRemoteEventForCurrentChange(t,e==="current",ft.EMPTY_BYTE_STRING);await fe(s,a,u);break}case"rejected":await Zn(s.localStore,t,!0),er(s,t,n);break;default:O(64155,e)}}async function S_(r,t,e){const n=Oi(r);if(n.gu){for(const s of t){if(n.Iu.has(s)&&n.sharedClientState.isActiveQueryTarget(s)){x(Ue,"Adding an already active target "+s);continue}const i=await Dd(n.localStore,s),a=await Xn(n.localStore,i);await Ba(n,tf(i),a.targetId,!1,a.resumeToken),Mi(n.remoteStore,a)}for(const s of e)n.Iu.has(s)&&await Zn(n.localStore,s,!1).then((()=>{tr(n.remoteStore,s),er(n,s)})).catch(Oe)}}function Oi(r){const t=F(r);return t.remoteStore.remoteSyncer.applyRemoteEvent=Xd.bind(null,t),t.remoteStore.remoteSyncer.getRemoteKeysForTarget=T_.bind(null,t),t.remoteStore.remoteSyncer.rejectListen=m_.bind(null,t),t.Pu.J_=s_.bind(null,t.eventManager),t.Pu.yu=i_.bind(null,t.eventManager),t}function Ga(r){const t=F(r);return t.remoteStore.remoteSyncer.applySuccessfulWrite=g_.bind(null,t),t.remoteStore.remoteSyncer.rejectFailedWrite=p_.bind(null,t),t}function V_(r,t,e){const n=F(r);(async function(i,a,u){try{const c=await a.getMetadata();if(await(function(v,C){const N=F(v),D=gt(C.createTime);return N.persistence.runTransaction("hasNewerBundle","readonly",(q=>N.Pi.getBundleMetadata(q,C.id))).then((q=>!!q&&q.createTime.compareTo(D)>=0))})(i.localStore,c))return await a.close(),u._completeWith((function(v){return{taskState:"Success",documentsLoaded:v.totalDocuments,bytesLoaded:v.totalBytes,totalDocuments:v.totalDocuments,totalBytes:v.totalBytes}})(c)),Promise.resolve(new Set);u._updateProgress(Qd(c));const h=new qa(c,a.serializer);let f=await a.Su();for(;f;){const p=await h.Ga(f);p&&u._updateProgress(p),f=await a.Su()}const m=await h.ja(i.localStore);return await fe(i,m.Ja,void 0),await(function(v,C){const N=F(v);return N.persistence.runTransaction("Save bundle","readwrite",(D=>N.Pi.saveBundleMetadata(D,C)))})(i.localStore,c),u._completeWith(m.progress),Promise.resolve(m.Ha)}catch(c){return Gt(Ue,`Loading bundle failed with ${c}`),u._failWith(c),Promise.resolve(new Set)}})(n,t,e).then((s=>{n.sharedClientState.notifyBundleLoaded(s)}))}class nr{constructor(){this.kind="memory",this.synchronizeTabs=!1}async initialize(t){this.serializer=yn(t.databaseInfo.databaseId),this.sharedClientState=this.Du(t),this.persistence=this.Cu(t),await this.persistence.start(),this.localStore=this.vu(t),this.gcScheduler=this.Fu(t,this.localStore),this.indexBackfillerScheduler=this.Mu(t,this.localStore)}Fu(t,e){return null}Mu(t,e){return null}vu(t){return Vd(this.persistence,new Sd,t.initialUser,this.serializer)}Cu(t){return new va(Fi.Vi,this.serializer)}Du(t){return new Ld}async terminate(){var t,e;(t=this.gcScheduler)==null||t.stop(),(e=this.indexBackfillerScheduler)==null||e.stop(),this.sharedClientState.shutdown(),await this.persistence.shutdown()}}nr.provider={build:()=>new nr};class Ka extends nr{constructor(t){super(),this.cacheSizeBytes=t}Fu(t,e){L(this.persistence.referenceDelegate instanceof mi,46915);const n=this.persistence.referenceDelegate.garbageCollector;return new Ed(n,t.asyncQueue,e)}Cu(t){const e=this.cacheSizeBytes!==void 0?Ct.withCacheSize(this.cacheSizeBytes):Ct.DEFAULT;return new va((n=>mi.Vi(n,e)),this.serializer)}}class $a extends nr{constructor(t,e,n){super(),this.xu=t,this.cacheSizeBytes=e,this.forceOwnership=n,this.kind="persistent",this.synchronizeTabs=!1}async initialize(t){await super.initialize(t),await this.xu.initialize(this,t),await Ga(this.xu.syncEngine),await cr(this.xu.remoteStore),await this.persistence.zi((()=>(this.gcScheduler&&!this.gcScheduler.started&&this.gcScheduler.start(),this.indexBackfillerScheduler&&!this.indexBackfillerScheduler.started&&this.indexBackfillerScheduler.start(),Promise.resolve())))}vu(t){return Vd(this.persistence,new Sd,t.initialUser,this.serializer)}Fu(t,e){const n=this.persistence.referenceDelegate.garbageCollector;return new Ed(n,t.asyncQueue,e)}Mu(t,e){const n=new Mm(e,this.persistence);return new Fm(t.asyncQueue,n)}Cu(t){const e=Pa(t.databaseInfo.databaseId,t.databaseInfo.persistenceKey),n=this.cacheSizeBytes!==void 0?Ct.withCacheSize(this.cacheSizeBytes):Ct.DEFAULT;return new Ra(this.synchronizeTabs,e,t.clientId,n,t.asyncQueue,qd(),ni(),this.serializer,this.sharedClientState,!!this.forceOwnership)}Du(t){return new Ld}}class ef extends $a{constructor(t,e){super(t,e,!1),this.xu=t,this.cacheSizeBytes=e,this.synchronizeTabs=!0}async initialize(t){await super.initialize(t);const e=this.xu.syncEngine;this.sharedClientState instanceof Ao&&(this.sharedClientState.syncEngine={So:A_.bind(null,e),Do:P_.bind(null,e),Co:S_.bind(null,e),hs:R_.bind(null,e),bo:w_.bind(null,e)},await this.sharedClientState.start()),await this.persistence.zi((async n=>{await v_(this.xu.syncEngine,n),this.gcScheduler&&(n&&!this.gcScheduler.started?this.gcScheduler.start():n||this.gcScheduler.stop()),this.indexBackfillerScheduler&&(n&&!this.indexBackfillerScheduler.started?this.indexBackfillerScheduler.start():n||this.indexBackfillerScheduler.stop())}))}Du(t){const e=qd();if(!Ao.v(e))throw new b(P.UNIMPLEMENTED,"IndexedDB persistence is only available on platforms that support LocalStorage.");const n=Pa(t.databaseInfo.databaseId,t.databaseInfo.persistenceKey);return new Ao(e,t.asyncQueue,n,t.clientId,t.initialUser)}}class Fe{async initialize(t,e){this.localStore||(this.localStore=t.localStore,this.sharedClientState=t.sharedClientState,this.datastore=this.createDatastore(e),this.remoteStore=this.createRemoteStore(e),this.eventManager=this.createEventManager(e),this.syncEngine=this.createSyncEngine(e,!t.synchronizeTabs),this.sharedClientState.onlineStateHandler=n=>yl(this.syncEngine,n,1),this.remoteStore.remoteSyncer.handleCredentialChange=I_.bind(null,this.syncEngine),await Jo(this.remoteStore,this.syncEngine.isPrimaryClient))}createEventManager(t){return(function(){return new r_})()}createDatastore(t){const e=yn(t.databaseInfo.databaseId),n=Lp(t.databaseInfo);return zp(t.authCredentials,t.appCheckCredentials,n,e)}createRemoteStore(t){return(function(n,s,i,a,u){return new Kp(n,s,i,a,u)})(this.localStore,this.datastore,t.asyncQueue,(e=>yl(this.syncEngine,e,0)),(function(){return hl.v()?new hl:new kp})())}createSyncEngine(t,e){return(function(s,i,a,u,c,h,f){const m=new u_(s,i,a,u,c,h);return f&&(m.gu=!0),m})(this.localStore,this.remoteStore,this.eventManager,this.sharedClientState,t.initialUser,t.maxConcurrentLimboResolutions,e)}async terminate(){var t,e;await(async function(s){const i=F(s);x(gn,"RemoteStore shutting down."),i.Ea.add(5),await ur(i),i.Aa.shutdown(),i.Va.set("Unknown")})(this.remoteStore),(t=this.datastore)==null||t.terminate(),(e=this.eventManager)==null||e.terminate()}}Fe.provider={build:()=>new Fe};function Tl(r,t=10240){let e=0;return{async read(){if(e<r.byteLength){const n={value:r.slice(e,e+t),done:!1};return e+=t,n}return{done:!0}},async cancel(){},releaseLock(){},closed:Promise.resolve()}}/**
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
 *//**
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
 */class Li{constructor(t){this.observer=t,this.muted=!1}next(t){this.muted||this.observer.next&&this.Ou(this.observer.next,t)}error(t){this.muted||(this.observer.error?this.Ou(this.observer.error,t):mt("Uncaught Error in snapshot listener:",t.toString()))}Nu(){this.muted=!0}Ou(t,e){setTimeout((()=>{this.muted||t(e)}),0)}}/**
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
 */class b_{constructor(t,e){this.Bu=t,this.serializer=e,this.metadata=new Rt,this.buffer=new Uint8Array,this.Lu=(function(){return new TextDecoder("utf-8")})(),this.ku().then((n=>{n&&n.Ua()?this.metadata.resolve(n.qa.metadata):this.metadata.reject(new Error(`The first element of the bundle is not a metadata, it is
             ${JSON.stringify(n==null?void 0:n.qa)}`))}),(n=>this.metadata.reject(n)))}close(){return this.Bu.cancel()}async getMetadata(){return this.metadata.promise}async Su(){return await this.getMetadata(),this.ku()}async ku(){const t=await this.Ku();if(t===null)return null;const e=this.Lu.decode(t),n=Number(e);isNaN(n)&&this.qu(`length string (${e}) is not valid number`);const s=await this.Uu(n);return new $d(JSON.parse(s),t.length+n)}$u(){return this.buffer.findIndex((t=>t===123))}async Ku(){for(;this.$u()<0&&!await this.Wu(););if(this.buffer.length===0)return null;const t=this.$u();t<0&&this.qu("Reached the end of bundle when a length string is expected.");const e=this.buffer.slice(0,t);return this.buffer=this.buffer.slice(t),e}async Uu(t){for(;this.buffer.length<t;)await this.Wu()&&this.qu("Reached the end of bundle when more is expected.");const e=this.Lu.decode(this.buffer.slice(0,t));return this.buffer=this.buffer.slice(t),e}qu(t){throw this.Bu.cancel(),new Error(`Invalid bundle format: ${t}`)}async Wu(){const t=await this.Bu.read();if(!t.done){const e=new Uint8Array(this.buffer.length+t.value.length);e.set(this.buffer),e.set(t.value,this.buffer.length),this.buffer=e}return t.done}}/**
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
 */class C_{constructor(t,e){this.bundleData=t,this.serializer=e,this.cursor=0,this.elements=[];let n=this.Su();if(!n||!n.Ua())throw new Error(`The first element of the bundle is not a metadata object, it is
         ${JSON.stringify(n==null?void 0:n.qa)}`);this.metadata=n;do n=this.Su(),n!==null&&this.elements.push(n);while(n!==null)}getMetadata(){return this.metadata}Qu(){return this.elements}Su(){if(this.cursor===this.bundleData.length)return null;const t=this.Ku(),e=this.Uu(t);return new $d(JSON.parse(e),t)}Uu(t){if(this.cursor+t>this.bundleData.length)throw new b(P.INTERNAL,"Reached the end of bundle when more is expected.");return this.bundleData.slice(this.cursor,this.cursor+=t)}Ku(){const t=this.cursor;let e=this.cursor;for(;e<this.bundleData.length;){if(this.bundleData[e]==="{"){if(e===t)throw new Error("First character is a bracket and not a number");return this.cursor=e,Number(this.bundleData.slice(t,e))}e++}throw new Error("Reached the end of bundle when more is expected.")}}/**
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
 */let x_=class{constructor(t){this.datastore=t,this.readVersions=new Map,this.mutations=[],this.committed=!1,this.lastTransactionError=null,this.writtenDocs=new Set}async lookup(t){if(this.ensureCommitNotCalled(),this.mutations.length>0)throw this.lastTransactionError=new b(P.INVALID_ARGUMENT,"Firestore transactions require all reads to be executed before all writes."),this.lastTransactionError;const e=await(async function(s,i){const a=F(s),u={documents:i.map((m=>is(a.serializer,m)))},c=await a.jo("BatchGetDocuments",a.serializer.databaseId,$.emptyPath(),u,i.length),h=new Map;c.forEach((m=>{const p=$g(a.serializer,m);h.set(p.key.toString(),p)}));const f=[];return i.forEach((m=>{const p=h.get(m.toString());L(!!p,55234,{key:m}),f.push(p)})),f})(this.datastore,t);return e.forEach((n=>this.recordVersion(n))),e}set(t,e){this.write(e.toMutation(t,this.precondition(t))),this.writtenDocs.add(t.toString())}update(t,e){try{this.write(e.toMutation(t,this.preconditionForUpdate(t)))}catch(n){this.lastTransactionError=n}this.writtenDocs.add(t.toString())}delete(t){this.write(new ar(t,this.precondition(t))),this.writtenDocs.add(t.toString())}async commit(){if(this.ensureCommitNotCalled(),this.lastTransactionError)throw this.lastTransactionError;const t=this.readVersions;this.mutations.forEach((e=>{t.delete(e.key.toString())})),t.forEach(((e,n)=>{const s=k.fromPath(n);this.mutations.push(new ga(s,this.precondition(s)))})),await(async function(n,s){const i=F(n),a={writes:s.map((u=>os(i.serializer,u)))};await i.Wo("Commit",i.serializer.databaseId,$.emptyPath(),a)})(this.datastore,this.mutations),this.committed=!0}recordVersion(t){let e;if(t.isFoundDocument())e=t.version;else{if(!t.isNoDocument())throw O(50498,{Gu:t.constructor.name});e=B.min()}const n=this.readVersions.get(t.key.toString());if(n){if(!e.isEqual(n))throw new b(P.ABORTED,"Document version changed between two reads.")}else this.readVersions.set(t.key.toString(),e)}precondition(t){const e=this.readVersions.get(t.toString());return!this.writtenDocs.has(t.toString())&&e?e.isEqual(B.min())?lt.exists(!1):lt.updateTime(e):lt.none()}preconditionForUpdate(t){const e=this.readVersions.get(t.toString());if(!this.writtenDocs.has(t.toString())&&e){if(e.isEqual(B.min()))throw new b(P.INVALID_ARGUMENT,"Can't update a document that doesn't exist.");return lt.updateTime(e)}return lt.exists(!0)}write(t){this.ensureCommitNotCalled(),this.mutations.push(t)}ensureCommitNotCalled(){}};/**
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
 */class D_{constructor(t,e,n,s,i){this.asyncQueue=t,this.datastore=e,this.options=n,this.updateFunction=s,this.deferred=i,this.zu=n.maxAttempts,this.M_=new Ca(this.asyncQueue,"transaction_retry")}ju(){this.zu-=1,this.Hu()}Hu(){this.M_.p_((async()=>{const t=new x_(this.datastore),e=this.Ju(t);e&&e.then((n=>{this.asyncQueue.enqueueAndForget((()=>t.commit().then((()=>{this.deferred.resolve(n)})).catch((s=>{this.Zu(s)}))))})).catch((n=>{this.Zu(n)}))}))}Ju(t){try{const e=this.updateFunction(t);return!ls(e)&&e.catch&&e.then?e:(this.deferred.reject(Error("Transaction callback must return a Promise")),null)}catch(e){return this.deferred.reject(e),null}}Zu(t){this.zu>0&&this.Xu(t)?(this.zu-=1,this.asyncQueue.enqueueAndForget((()=>(this.Hu(),Promise.resolve())))):this.deferred.reject(t)}Xu(t){if((t==null?void 0:t.name)==="FirebaseError"){const e=t.code;return e==="aborted"||e==="failed-precondition"||e==="already-exists"||!Hh(e)}return!1}}/**
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
 */const Me="FirestoreClient";class N_{constructor(t,e,n,s,i){this.authCredentials=t,this.appCheckCredentials=e,this.asyncQueue=n,this._databaseInfo=s,this.user=At.UNAUTHENTICATED,this.clientId=ea.newId(),this.authCredentialListener=()=>Promise.resolve(),this.appCheckCredentialListener=()=>Promise.resolve(),this._uninitializedComponentsProvider=i,this.authCredentials.start(n,(async a=>{x(Me,"Received user=",a.uid),await this.authCredentialListener(a),this.user=a})),this.appCheckCredentials.start(n,(a=>(x(Me,"Received new app check token=",a),this.appCheckCredentialListener(a,this.user))))}get configuration(){return{asyncQueue:this.asyncQueue,databaseInfo:this._databaseInfo,clientId:this.clientId,authCredentials:this.authCredentials,appCheckCredentials:this.appCheckCredentials,initialUser:this.user,maxConcurrentLimboResolutions:100}}setCredentialChangeListener(t){this.authCredentialListener=t}setAppCheckTokenChangeListener(t){this.appCheckCredentialListener=t}terminate(){this.asyncQueue.enterRestrictedMode();const t=new Rt;return this.asyncQueue.enqueueAndForgetEvenWhileRestricted((async()=>{try{this._onlineComponents&&await this._onlineComponents.terminate(),this._offlineComponents&&await this._offlineComponents.terminate(),this.authCredentials.shutdown(),this.appCheckCredentials.shutdown(),t.resolve()}catch(e){const n=hr(e,"Failed to shutdown persistence");t.reject(n)}})),t.promise}}async function Ro(r,t){r.asyncQueue.verifyOperationInProgress(),x(Me,"Initializing OfflineComponentProvider");const e=r.configuration;await t.initialize(e);let n=e.initialUser;r.setCredentialChangeListener((async s=>{n.isEqual(s)||(await bd(t.localStore,s),n=s)})),t.persistence.setDatabaseDeletedListener((()=>r.terminate())),r._offlineComponents=t}async function El(r,t){r.asyncQueue.verifyOperationInProgress();const e=await Qa(r);x(Me,"Initializing OnlineComponentProvider"),await t.initialize(e,r.configuration),r.setCredentialChangeListener((n=>fl(t.remoteStore,n))),r.setAppCheckTokenChangeListener(((n,s)=>fl(t.remoteStore,s))),r._onlineComponents=t}async function Qa(r){if(!r._offlineComponents)if(r._uninitializedComponentsProvider){x(Me,"Using user provided OfflineComponentProvider");try{await Ro(r,r._uninitializedComponentsProvider._offline)}catch(t){const e=t;if(!(function(s){return s.name==="FirebaseError"?s.code===P.FAILED_PRECONDITION||s.code===P.UNIMPLEMENTED:!(typeof DOMException<"u"&&s instanceof DOMException)||s.code===22||s.code===20||s.code===11})(e))throw e;Gt("Error using user provided cache. Falling back to memory cache: "+e),await Ro(r,new nr)}}else x(Me,"Using default OfflineComponentProvider"),await Ro(r,new Ka(void 0));return r._offlineComponents}async function qi(r){return r._onlineComponents||(r._uninitializedComponentsProvider?(x(Me,"Using user provided OnlineComponentProvider"),await El(r,r._uninitializedComponentsProvider._online)):(x(Me,"Using default OnlineComponentProvider"),await El(r,new Fe))),r._onlineComponents}function nf(r){return Qa(r).then((t=>t.persistence))}function dr(r){return Qa(r).then((t=>t.localStore))}function rf(r){return qi(r).then((t=>t.remoteStore))}function Wa(r){return qi(r).then((t=>t.syncEngine))}function sf(r){return qi(r).then((t=>t.datastore))}async function rr(r){const t=await qi(r),e=t.eventManager;return e.onListen=c_.bind(null,t.syncEngine),e.onUnlisten=h_.bind(null,t.syncEngine),e.onFirstRemoteStoreListen=l_.bind(null,t.syncEngine),e.onLastRemoteStoreUnlisten=d_.bind(null,t.syncEngine),e}function k_(r){return r.asyncQueue.enqueue((async()=>{const t=await nf(r),e=await rf(r);return t.setNetworkEnabled(!0),(function(s){const i=F(s);return i.Ea.delete(0),ys(i)})(e)}))}function F_(r){return r.asyncQueue.enqueue((async()=>{const t=await nf(r),e=await rf(r);return t.setNetworkEnabled(!1),(async function(s){const i=F(s);i.Ea.add(0),await ur(i),i.Va.set("Offline")})(e)}))}function M_(r,t,e,n){const s=new Li(n),i=new La(t,s,e);return r.asyncQueue.enqueueAndForget((async()=>Fa(await rr(r),i))),()=>{s.Nu(),r.asyncQueue.enqueueAndForget((async()=>Ma(await rr(r),i)))}}function O_(r,t){const e=new Rt;return r.asyncQueue.enqueueAndForget((async()=>(async function(s,i,a){try{const u=await(function(h,f){const m=F(h);return m.persistence.runTransaction("read document","readonly",(p=>m.localDocuments.getDocument(p,f)))})(s,i);u.isFoundDocument()?a.resolve(u):u.isNoDocument()?a.resolve(null):a.reject(new b(P.UNAVAILABLE,"Failed to get document from cache. (However, this document may exist on the server. Run again without setting 'source' in the GetOptions to attempt to retrieve the document from the server.)"))}catch(u){const c=hr(u,`Failed to get document '${i} from cache`);a.reject(c)}})(await dr(r),t,e))),e.promise}function of(r,t,e={}){const n=new Rt;return r.asyncQueue.enqueueAndForget((async()=>(function(i,a,u,c,h){const f=new Li({next:p=>{f.Nu(),a.enqueueAndForget((()=>Ma(i,m)));const v=p.docs.has(u);!v&&p.fromCache?h.reject(new b(P.UNAVAILABLE,"Failed to get document because the client is offline.")):v&&p.fromCache&&c&&c.source==="server"?h.reject(new b(P.UNAVAILABLE,'Failed to get document from server. (However, this document does exist in the local cache. Run again without setting source to "server" to retrieve the cached document.)')):h.resolve(p)},error:p=>h.reject(p)}),m=new La(ir(u.path),f,{includeMetadataChanges:!0,Ka:!0});return Fa(i,m)})(await rr(r),r.asyncQueue,t,e,n))),n.promise}function L_(r,t){const e=new Rt;return r.asyncQueue.enqueueAndForget((async()=>(async function(s,i,a){try{const u=await gi(s,i,!0),c=new Jd(i,u.ks),h=c.ru(u.documents),f=c.applyChanges(h,!1);a.resolve(f.snapshot)}catch(u){const c=hr(u,`Failed to execute query '${i} against cache`);a.reject(c)}})(await dr(r),t,e))),e.promise}function af(r,t,e={}){const n=new Rt;return r.asyncQueue.enqueueAndForget((async()=>(function(i,a,u,c,h){const f=new Li({next:p=>{f.Nu(),a.enqueueAndForget((()=>Ma(i,m))),p.fromCache&&c.source==="server"?h.reject(new b(P.UNAVAILABLE,'Failed to get documents from server. (However, these documents may exist in the local cache. Run again without setting source to "server" to retrieve the cached documents.)')):h.resolve(p)},error:p=>h.reject(p)}),m=new La(u,f,{includeMetadataChanges:!0,Ka:!0});return Fa(i,m)})(await rr(r),r.asyncQueue,t,e,n))),n.promise}function q_(r,t,e){const n=new Rt;return r.asyncQueue.enqueueAndForget((async()=>{try{const s=await sf(r);n.resolve((async function(a,u,c){var N;const h=F(a),{request:f,gt:m,parent:p}=od(h.serializer,Dh(u),c);h.connection.Ko||delete f.parent;const v=(await h.jo("RunAggregationQuery",h.serializer.databaseId,p,f,1)).filter((D=>!!D.result));L(v.length===1,64727);const C=(N=v[0].result)==null?void 0:N.aggregateFields;return Object.keys(C).reduce(((D,q)=>(D[m[q]]=C[q],D)),{})})(s,t,e))}catch(s){n.reject(s)}})),n.promise}function B_(r,t){const e=new Rt;return r.asyncQueue.enqueueAndForget((async()=>f_(await Wa(r),t,e))),e.promise}function U_(r,t){const e=new Li(t);return r.asyncQueue.enqueueAndForget((async()=>(function(s,i){F(s).Ca.add(i),i.next()})(await rr(r),e))),()=>{e.Nu(),r.asyncQueue.enqueueAndForget((async()=>(function(s,i){F(s).Ca.delete(i)})(await rr(r),e)))}}function j_(r,t,e){const n=new Rt;return r.asyncQueue.enqueueAndForget((async()=>{const s=await sf(r);new D_(r.asyncQueue,s,e,t,n).ju()})),n.promise}function z_(r,t,e,n){const s=(function(a,u){let c;return c=typeof a=="string"?Yh().encode(a):a,(function(f,m){return new b_(f,m)})((function(f,m){if(f instanceof Uint8Array)return Tl(f,m);if(f instanceof ArrayBuffer)return Tl(new Uint8Array(f),m);if(f instanceof ReadableStream)return f.getReader();throw new Error("Source of `toByteStreamReader` has to be a ArrayBuffer or ReadableStream")})(c),u)})(e,yn(t));r.asyncQueue.enqueueAndForget((async()=>{V_(await Wa(r),s,n)}))}function G_(r,t){return r.asyncQueue.enqueue((async()=>(function(n,s){const i=F(n);return i.persistence.runTransaction("Get named query","readonly",(a=>i.Pi.getNamedQuery(a,s)))})(await dr(r),t)))}function uf(r,t){return(function(n,s){return new C_(n,s)})(r,t)}function K_(r,t){return r.asyncQueue.enqueue((async()=>(async function(n,s){const i=F(n),a=i.indexManager,u=[];return i.persistence.runTransaction("Configure indexes","readwrite",(c=>a.getFieldIndexes(c).next((h=>(function(m,p,v,C,N){m=[...m],p=[...p],m.sort(v),p.sort(v);const D=m.length,q=p.length;let j=0,U=0;for(;j<q&&U<D;){const X=v(m[U],p[j]);X<0?N(m[U++]):X>0?C(p[j++]):(j++,U++)}for(;j<q;)C(p[j++]);for(;U<D;)N(m[U++])})(h,s,xm,(f=>{u.push(a.addFieldIndex(c,f))}),(f=>{u.push(a.deleteFieldIndex(c,f))})))).next((()=>A.waitFor(u)))))})(await dr(r),t)))}function $_(r,t){return r.asyncQueue.enqueue((async()=>(function(n,s){F(n).Cs.As=s})(await dr(r),t)))}function Q_(r){return r.asyncQueue.enqueue((async()=>(function(e){const n=F(e),s=n.indexManager;return n.persistence.runTransaction("Delete All Indexes","readwrite",(i=>s.deleteAllFieldIndexes(i)))})(await dr(r))))}/**
 * @license
 * Copyright 2023 Google LLC
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
 */function cf(r){const t={};return r.timeoutSeconds!==void 0&&(t.timeoutSeconds=r.timeoutSeconds),t}/**
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
 */const W_="ComponentProvider",wl=new Map;function H_(r,t,e,n,s){return new lg(r,t,e,s.host,s.ssl,s.experimentalForceLongPolling,s.experimentalAutoDetectLongPolling,cf(s.experimentalLongPollingOptions),s.useFetchStreams,s.isUsingEmulator,n)}/**
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
 */const lf="firestore.googleapis.com",Al=!0;class vl{constructor(t){if(t.host===void 0){if(t.ssl!==void 0)throw new b(P.INVALID_ARGUMENT,"Can't provide ssl option if host option is not set");this.host=lf,this.ssl=Al}else this.host=t.host,this.ssl=t.ssl??Al;if(this.isUsingEmulator=t.emulatorOptions!==void 0,this.credentials=t.credentials,this.ignoreUndefinedProperties=!!t.ignoreUndefinedProperties,this.localCache=t.localCache,t.cacheSizeBytes===void 0)this.cacheSizeBytes=pd;else{if(t.cacheSizeBytes!==-1&&t.cacheSizeBytes<Td)throw new b(P.INVALID_ARGUMENT,"cacheSizeBytes must be at least 1048576");this.cacheSizeBytes=t.cacheSizeBytes}Cm("experimentalForceLongPolling",t.experimentalForceLongPolling,"experimentalAutoDetectLongPolling",t.experimentalAutoDetectLongPolling),this.experimentalForceLongPolling=!!t.experimentalForceLongPolling,this.experimentalForceLongPolling?this.experimentalAutoDetectLongPolling=!1:t.experimentalAutoDetectLongPolling===void 0?this.experimentalAutoDetectLongPolling=!0:this.experimentalAutoDetectLongPolling=!!t.experimentalAutoDetectLongPolling,this.experimentalLongPollingOptions=cf(t.experimentalLongPollingOptions??{}),(function(n){if(n.timeoutSeconds!==void 0){if(isNaN(n.timeoutSeconds))throw new b(P.INVALID_ARGUMENT,`invalid long polling timeout: ${n.timeoutSeconds} (must not be NaN)`);if(n.timeoutSeconds<5)throw new b(P.INVALID_ARGUMENT,`invalid long polling timeout: ${n.timeoutSeconds} (minimum allowed value is 5)`);if(n.timeoutSeconds>30)throw new b(P.INVALID_ARGUMENT,`invalid long polling timeout: ${n.timeoutSeconds} (maximum allowed value is 30)`)}})(this.experimentalLongPollingOptions),this.useFetchStreams=!!t.useFetchStreams}isEqual(t){return this.host===t.host&&this.ssl===t.ssl&&this.credentials===t.credentials&&this.cacheSizeBytes===t.cacheSizeBytes&&this.experimentalForceLongPolling===t.experimentalForceLongPolling&&this.experimentalAutoDetectLongPolling===t.experimentalAutoDetectLongPolling&&(function(n,s){return n.timeoutSeconds===s.timeoutSeconds})(this.experimentalLongPollingOptions,t.experimentalLongPollingOptions)&&this.ignoreUndefinedProperties===t.ignoreUndefinedProperties&&this.useFetchStreams===t.useFetchStreams}}class Is{constructor(t,e,n,s){this._authCredentials=t,this._appCheckCredentials=e,this._databaseId=n,this._app=s,this.type="firestore-lite",this._persistenceKey="(lite)",this._settings=new vl({}),this._settingsFrozen=!1,this._emulatorOptions={},this._terminateTask="notTerminated"}get app(){if(!this._app)throw new b(P.FAILED_PRECONDITION,"Firestore was not initialized using the Firebase SDK. 'app' is not available");return this._app}get _initialized(){return this._settingsFrozen}get _terminated(){return this._terminateTask!=="notTerminated"}_setSettings(t){if(this._settingsFrozen)throw new b(P.FAILED_PRECONDITION,"Firestore has already been started and its settings can no longer be changed. You can only modify settings before calling any other methods on a Firestore object.");this._settings=new vl(t),this._emulatorOptions=t.emulatorOptions||{},t.credentials!==void 0&&(this._authCredentials=(function(n){if(!n)return new Tm;switch(n.type){case"firstParty":return new vm(n.sessionIndex||"0",n.iamToken||null,n.authTokenFactory||null);case"provider":return n.client;default:throw new b(P.INVALID_ARGUMENT,"makeAuthCredentialsProvider failed due to invalid credential type")}})(t.credentials))}_getSettings(){return this._settings}_getEmulatorOptions(){return this._emulatorOptions}_freezeSettings(){return this._settingsFrozen=!0,this._settings}_delete(){return this._terminateTask==="notTerminated"&&(this._terminateTask=this._terminate()),this._terminateTask}async _restart(){this._terminateTask==="notTerminated"?await this._terminate():this._terminateTask="notTerminated"}toJSON(){return{app:this._app,databaseId:this._databaseId,settings:this._settings}}_terminate(){return(function(e){const n=wl.get(e);n&&(x(W_,"Removing Datastore"),wl.delete(e),n.terminate())})(this),Promise.resolve()}}function J_(r,t,e,n={}){var h;r=Q(r,Is);const s=Zo(t),i=r._getSettings(),a={...i,emulatorOptions:r._getEmulatorOptions()},u=`${t}:${e}`;s&&(Ml(`https://${u}`),um("Firestore",!0)),i.host!==lf&&i.host!==u&&Gt("Host has been set in both settings() and connectFirestoreEmulator(), emulator host will be used.");const c={...i,host:u,ssl:s,emulatorOptions:n};if(!cs(c,a)&&(r._setSettings(c),n.mockUserToken)){let f,m;if(typeof n.mockUserToken=="string")f=n.mockUserToken,m=At.MOCK_USER;else{f=cm(n.mockUserToken,(h=r._app)==null?void 0:h.options.projectId);const p=n.mockUserToken.sub||n.mockUserToken.user_id;if(!p)throw new b(P.INVALID_ARGUMENT,"mockUserToken must contain 'sub' or 'user_id' field!");m=new At(p)}r._authCredentials=new Em(new Ql(f,m))}}/**
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
 */class Pt{constructor(t,e,n){this.converter=e,this._query=n,this.type="query",this.firestore=t}withConverter(t){return new Pt(this.firestore,t,this._query)}}class nt{constructor(t,e,n){this.converter=e,this._key=n,this.type="document",this.firestore=t}get _path(){return this._key.path}get id(){return this._key.path.lastSegment()}get path(){return this._key.path.canonicalString()}get parent(){return new ne(this.firestore,this.converter,this._key.path.popLast())}withConverter(t){return new nt(this.firestore,t,this._key)}toJSON(){return{type:nt._jsonSchemaVersion,referencePath:this._key.toString()}}static fromJSON(t,e,n){if(_n(e,nt._jsonSchema))return new nt(t,n||null,new k($.fromString(e.referencePath)))}}nt._jsonSchemaVersion="firestore/documentReference/1.0",nt._jsonSchema={type:_t("string",nt._jsonSchemaVersion),referencePath:_t("string")};class ne extends Pt{constructor(t,e,n){super(t,e,ir(n)),this._path=n,this.type="collection"}get id(){return this._query.path.lastSegment()}get path(){return this._query.path.canonicalString()}get parent(){const t=this._path.popLast();return t.isEmpty()?null:new nt(this.firestore,null,new k(t))}withConverter(t){return new ne(this.firestore,t,this._path)}}function Vy(r,t,...e){if(r=It(r),na("collection","path",t),r instanceof Is){const n=$.fromString(t,...e);return dc(n),new ne(r,null,n)}{if(!(r instanceof nt||r instanceof ne))throw new b(P.INVALID_ARGUMENT,"Expected first argument to collection() to be a CollectionReference, a DocumentReference or FirebaseFirestore");const n=r._path.child($.fromString(t,...e));return dc(n),new ne(r.firestore,null,n)}}function by(r,t){if(r=Q(r,Is),na("collectionGroup","collection id",t),t.indexOf("/")>=0)throw new b(P.INVALID_ARGUMENT,`Invalid collection ID '${t}' passed to function collectionGroup(). Collection IDs must not contain '/'.`);return new Pt(r,null,(function(n){return new le($.emptyPath(),n)})(t))}function Y_(r,t,...e){if(r=It(r),arguments.length===1&&(t=ea.newId()),na("doc","path",t),r instanceof Is){const n=$.fromString(t,...e);return hc(n),new nt(r,null,new k(n))}{if(!(r instanceof nt||r instanceof ne))throw new b(P.INVALID_ARGUMENT,"Expected first argument to doc() to be a CollectionReference, a DocumentReference or FirebaseFirestore");const n=r._path.child($.fromString(t,...e));return hc(n),new nt(r.firestore,r instanceof ne?r.converter:null,new k(n))}}function Cy(r,t){return r=It(r),t=It(t),(r instanceof nt||r instanceof ne)&&(t instanceof nt||t instanceof ne)&&r.firestore===t.firestore&&r.path===t.path&&r.converter===t.converter}function hf(r,t){return r=It(r),t=It(t),r instanceof Pt&&t instanceof Pt&&r.firestore===t.firestore&&fs(r._query,t._query)&&r.converter===t.converter}/**
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
 */const Rl="AsyncQueue";class Pl{constructor(t=Promise.resolve()){this.Yu=[],this.ec=!1,this.tc=[],this.nc=null,this.rc=!1,this.sc=!1,this.oc=[],this.M_=new Ca(this,"async_queue_retry"),this._c=()=>{const n=ni();n&&x(Rl,"Visibility state changed to "+n.visibilityState),this.M_.w_()},this.ac=t;const e=ni();e&&typeof e.addEventListener=="function"&&e.addEventListener("visibilitychange",this._c)}get isShuttingDown(){return this.ec}enqueueAndForget(t){this.enqueue(t)}enqueueAndForgetEvenWhileRestricted(t){this.uc(),this.cc(t)}enterRestrictedMode(t){if(!this.ec){this.ec=!0,this.sc=t||!1;const e=ni();e&&typeof e.removeEventListener=="function"&&e.removeEventListener("visibilitychange",this._c)}}enqueue(t){if(this.uc(),this.ec)return new Promise((()=>{}));const e=new Rt;return this.cc((()=>this.ec&&this.sc?Promise.resolve():(t().then(e.resolve,e.reject),e.promise))).then((()=>e.promise))}enqueueRetryable(t){this.enqueueAndForget((()=>(this.Yu.push(t),this.lc())))}async lc(){if(this.Yu.length!==0){try{await this.Yu[0](),this.Yu.shift(),this.M_.reset()}catch(t){if(!Le(t))throw t;x(Rl,"Operation failed with retryable error: "+t)}this.Yu.length>0&&this.M_.p_((()=>this.lc()))}}cc(t){const e=this.ac.then((()=>(this.rc=!0,t().catch((n=>{throw this.nc=n,this.rc=!1,mt("INTERNAL UNHANDLED ERROR: ",Sl(n)),n})).then((n=>(this.rc=!1,n))))));return this.ac=e,e}enqueueAfterDelay(t,e,n){this.uc(),this.oc.indexOf(t)>-1&&(e=0);const s=ka.createAndSchedule(this,t,e,n,(i=>this.hc(i)));return this.tc.push(s),s}uc(){this.nc&&O(47125,{Pc:Sl(this.nc)})}verifyOperationInProgress(){}async Tc(){let t;do t=this.ac,await t;while(t!==this.ac)}Ic(t){for(const e of this.tc)if(e.timerId===t)return!0;return!1}Ec(t){return this.Tc().then((()=>{this.tc.sort(((e,n)=>e.targetTimeMs-n.targetTimeMs));for(const e of this.tc)if(e.skipDelay(),t!=="all"&&e.timerId===t)break;return this.Tc()}))}Rc(t){this.oc.push(t)}hc(t){const e=this.tc.indexOf(t);this.tc.splice(e,1)}}function Sl(r){let t=r.message||"";return r.stack&&(t=r.stack.includes(r.message)?r.stack:r.message+`
`+r.stack),t}/**
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
 */class X_{constructor(){this._progressObserver={},this._taskCompletionResolver=new Rt,this._lastProgress={taskState:"Running",totalBytes:0,totalDocuments:0,bytesLoaded:0,documentsLoaded:0}}onProgress(t,e,n){this._progressObserver={next:t,error:e,complete:n}}catch(t){return this._taskCompletionResolver.promise.catch(t)}then(t,e){return this._taskCompletionResolver.promise.then(t,e)}_completeWith(t){this._updateProgress(t),this._progressObserver.complete&&this._progressObserver.complete(),this._taskCompletionResolver.resolve(t)}_failWith(t){this._lastProgress.taskState="Error",this._progressObserver.next&&this._progressObserver.next(this._lastProgress),this._progressObserver.error&&this._progressObserver.error(t),this._taskCompletionResolver.reject(t)}_updateProgress(t){this._lastProgress=t,this._progressObserver.next&&this._progressObserver.next(t)}}/**
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
 */const xy=-1;class st extends Is{constructor(t,e,n,s){super(t,e,n,s),this.type="firestore",this._queue=new Pl,this._persistenceKey=(s==null?void 0:s.name)||"[DEFAULT]"}async _terminate(){if(this._firestoreClient){const t=this._firestoreClient.terminate();this._queue=new Pl(t),this._firestoreClient=void 0,await t}}}function Dy(r,t,e){e||(e=es);const n=Ol(r,"firestore");if(n.isInitialized(e)){const s=n.getImmediate({identifier:e}),i=n.getOptions(e);if(cs(i,t))return s;throw new b(P.FAILED_PRECONDITION,"initializeFirestore() has already been called with different options. To avoid this error, call initializeFirestore() with the same options as when it was originally called, or call getFirestore() to return the already initialized instance.")}if(t.cacheSizeBytes!==void 0&&t.localCache!==void 0)throw new b(P.INVALID_ARGUMENT,"cache and cacheSizeBytes cannot be specified at the same time as cacheSizeBytes willbe deprecated. Instead, specify the cache size in the cache object");if(t.cacheSizeBytes!==void 0&&t.cacheSizeBytes!==-1&&t.cacheSizeBytes<Td)throw new b(P.INVALID_ARGUMENT,"cacheSizeBytes must be at least 1048576");return t.host&&Zo(t.host)&&Ml(t.host),n.initialize({options:t,instanceIdentifier:e})}function Ny(r,t){const e=typeof r=="object"?r:lm(),n=typeof r=="string"?r:t||es,s=Ol(e,"firestore").getImmediate({identifier:n});if(!s._initialized){const i=hm("firestore");i&&J_(s,...i)}return s}function ht(r){if(r._terminated)throw new b(P.FAILED_PRECONDITION,"The client has already been terminated.");return r._firestoreClient||df(r),r._firestoreClient}function df(r){var n,s,i,a;const t=r._freezeSettings(),e=H_(r._databaseId,((n=r._app)==null?void 0:n.options.appId)||"",r._persistenceKey,(s=r._app)==null?void 0:s.options.apiKey,t);r._componentsProvider||(i=t.localCache)!=null&&i._offlineComponentProvider&&((a=t.localCache)!=null&&a._onlineComponentProvider)&&(r._componentsProvider={_offline:t.localCache._offlineComponentProvider,_online:t.localCache._onlineComponentProvider}),r._firestoreClient=new N_(r._authCredentials,r._appCheckCredentials,r._queue,e,r._componentsProvider&&(function(c){const h=c==null?void 0:c._online.build();return{_offline:c==null?void 0:c._offline.build(h),_online:h}})(r._componentsProvider))}function ky(r,t){Gt("enableIndexedDbPersistence() will be deprecated in the future, you can use `FirestoreSettings.cache` instead.");const e=r._freezeSettings();return ff(r,Fe.provider,{build:n=>new $a(n,e.cacheSizeBytes,t==null?void 0:t.forceOwnership)}),Promise.resolve()}async function Fy(r){Gt("enableMultiTabIndexedDbPersistence() will be deprecated in the future, you can use `FirestoreSettings.cache` instead.");const t=r._freezeSettings();ff(r,Fe.provider,{build:e=>new ef(e,t.cacheSizeBytes)})}function ff(r,t,e){if((r=Q(r,st))._firestoreClient||r._terminated)throw new b(P.FAILED_PRECONDITION,"Firestore has already been started and persistence can no longer be enabled. You can only enable persistence before calling any other methods on a Firestore object.");if(r._componentsProvider||r._getSettings().localCache)throw new b(P.FAILED_PRECONDITION,"SDK cache is already specified.");r._componentsProvider={_online:t,_offline:e},df(r)}function My(r){if(r._initialized&&!r._terminated)throw new b(P.FAILED_PRECONDITION,"Persistence can only be cleared before a Firestore instance is initialized or after it is terminated.");const t=new Rt;return r._queue.enqueueAndForgetEvenWhileRestricted((async()=>{try{await(async function(n){if(!te.v())return Promise.resolve();const s=n+Pd;await te.delete(s)})(Pa(r._databaseId,r._persistenceKey)),t.resolve()}catch(e){t.reject(e)}})),t.promise}function Oy(r){return(function(e){const n=new Rt;return e.asyncQueue.enqueueAndForget((async()=>__(await Wa(e),n))),n.promise})(ht(r=Q(r,st)))}function Ly(r){return k_(ht(r=Q(r,st)))}function qy(r){return F_(ht(r=Q(r,st)))}function By(r){return dm(r.app,"firestore",r._databaseId.database),r._delete()}function Vl(r,t){const e=ht(r=Q(r,st)),n=new X_;return z_(e,r._databaseId,t,n),n}function Z_(r,t){return G_(ht(r=Q(r,st)),t).then((e=>e?new Pt(r,null,e.query):null))}/**
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
 */class Ut{constructor(t){this._byteString=t}static fromBase64String(t){try{return new Ut(ft.fromBase64String(t))}catch(e){throw new b(P.INVALID_ARGUMENT,"Failed to construct data from Base64 string: "+e)}}static fromUint8Array(t){return new Ut(ft.fromUint8Array(t))}toBase64(){return this._byteString.toBase64()}toUint8Array(){return this._byteString.toUint8Array()}toString(){return"Bytes(base64: "+this.toBase64()+")"}isEqual(t){return this._byteString.isEqual(t._byteString)}toJSON(){return{type:Ut._jsonSchemaVersion,bytes:this.toBase64()}}static fromJSON(t){if(_n(t,Ut._jsonSchema))return Ut.fromBase64String(t.bytes)}}Ut._jsonSchemaVersion="firestore/bytes/1.0",Ut._jsonSchema={type:_t("string",Ut._jsonSchemaVersion),bytes:_t("string")};/**
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
 */class fr{constructor(...t){for(let e=0;e<t.length;++e)if(t[e].length===0)throw new b(P.INVALID_ARGUMENT,"Invalid field name at argument $(i + 1). Field names must not be empty.");this._internalPath=new ct(t)}isEqual(t){return this._internalPath.isEqual(t._internalPath)}}function Uy(){return new fr(bo)}/**
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
 */class In{constructor(t){this._methodName=t}}/**
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
 */class re{constructor(t,e){if(!isFinite(t)||t<-90||t>90)throw new b(P.INVALID_ARGUMENT,"Latitude must be a number between -90 and 90, but was: "+t);if(!isFinite(e)||e<-180||e>180)throw new b(P.INVALID_ARGUMENT,"Longitude must be a number between -180 and 180, but was: "+e);this._lat=t,this._long=e}get latitude(){return this._lat}get longitude(){return this._long}isEqual(t){return this._lat===t._lat&&this._long===t._long}_compareTo(t){return z(this._lat,t._lat)||z(this._long,t._long)}toJSON(){return{latitude:this._lat,longitude:this._long,type:re._jsonSchemaVersion}}static fromJSON(t){if(_n(t,re._jsonSchema))return new re(t.latitude,t.longitude)}}re._jsonSchemaVersion="firestore/geoPoint/1.0",re._jsonSchema={type:_t("string",re._jsonSchemaVersion),latitude:_t("number"),longitude:_t("number")};/**
 * @license
 * Copyright 2024 Google LLC
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
 */class $t{constructor(t){this._values=(t||[]).map((e=>e))}toArray(){return this._values.map((t=>t))}isEqual(t){return(function(n,s){if(n.length!==s.length)return!1;for(let i=0;i<n.length;++i)if(n[i]!==s[i])return!1;return!0})(this._values,t._values)}toJSON(){return{type:$t._jsonSchemaVersion,vectorValues:this._values}}static fromJSON(t){if(_n(t,$t._jsonSchema)){if(Array.isArray(t.vectorValues)&&t.vectorValues.every((e=>typeof e=="number")))return new $t(t.vectorValues);throw new b(P.INVALID_ARGUMENT,"Expected 'vectorValues' field to be a number array")}}}$t._jsonSchemaVersion="firestore/vectorValue/1.0",$t._jsonSchema={type:_t("string",$t._jsonSchemaVersion),vectorValues:_t("object")};/**
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
 */const ty=/^__.*__$/;class ey{constructor(t,e,n){this.data=t,this.fieldMask=e,this.fieldTransforms=n}toMutation(t,e){return this.fieldMask!==null?new de(t,this.data,this.fieldMask,e,this.fieldTransforms):new or(t,this.data,e,this.fieldTransforms)}}class mf{constructor(t,e,n){this.data=t,this.fieldMask=e,this.fieldTransforms=n}toMutation(t,e){return new de(t,this.data,this.fieldMask,e,this.fieldTransforms)}}function gf(r){switch(r){case 0:case 2:case 1:return!0;case 3:case 4:return!1;default:throw O(40011,{dataSource:r})}}class Bi{constructor(t,e,n,s,i,a){this.settings=t,this.databaseId=e,this.serializer=n,this.ignoreUndefinedProperties=s,i===void 0&&this.validatePath(),this.fieldTransforms=i||[],this.fieldMask=a||[]}get path(){return this.settings.path}get dataSource(){return this.settings.dataSource}contextWith(t){return new Bi({...this.settings,...t},this.databaseId,this.serializer,this.ignoreUndefinedProperties,this.fieldTransforms,this.fieldMask)}childContextForField(t){var s;const e=(s=this.path)==null?void 0:s.child(t),n=this.contextWith({path:e,arrayElement:!1});return n.validatePathSegment(t),n}childContextForFieldPath(t){var s;const e=(s=this.path)==null?void 0:s.child(t),n=this.contextWith({path:e,arrayElement:!1});return n.validatePath(),n}childContextForArray(t){return this.contextWith({path:void 0,arrayElement:!0})}createError(t){return Ii(t,this.settings.methodName,this.settings.hasConverter||!1,this.path,this.settings.targetDoc)}contains(t){return this.fieldMask.find((e=>t.isPrefixOf(e)))!==void 0||this.fieldTransforms.find((e=>t.isPrefixOf(e.field)))!==void 0}validatePath(){if(this.path)for(let t=0;t<this.path.length;t++)this.validatePathSegment(this.path.get(t))}validatePathSegment(t){if(t.length===0)throw this.createError("Document fields must not be empty");if(gf(this.dataSource)&&ty.test(t))throw this.createError('Document fields cannot begin and end with "__"')}}class ny{constructor(t,e,n){this.databaseId=t,this.ignoreUndefinedProperties=e,this.serializer=n||yn(t)}createContext(t,e,n,s=!1){return new Bi({dataSource:t,methodName:e,targetDoc:n,path:ct.emptyPath(),arrayElement:!1,hasConverter:s},this.databaseId,this.serializer,this.ignoreUndefinedProperties)}}function Tn(r){const t=r._freezeSettings(),e=yn(r._databaseId);return new ny(r._databaseId,!!t.ignoreUndefinedProperties,e)}function Ui(r,t,e,n,s,i={}){const a=r.createContext(i.merge||i.mergeFields?2:0,t,e,s);eu("Data must be an object, but it was:",a,n);const u=yf(n,a);let c,h;if(i.merge)c=new Ot(a.fieldMask),h=a.fieldTransforms;else if(i.mergeFields){const f=[];for(const m of i.mergeFields){const p=ce(t,m,e);if(!a.contains(p))throw new b(P.INVALID_ARGUMENT,`Field '${p}' is specified in your field mask but missing from your input data.`);Tf(f,p)||f.push(p)}c=new Ot(f),h=a.fieldTransforms.filter((m=>c.covers(m.field)))}else c=null,h=a.fieldTransforms;return new ey(new vt(u),c,h)}class Ts extends In{_toFieldTransform(t){if(t.dataSource!==2)throw t.dataSource===1?t.createError(`${this._methodName}() can only appear at the top level of your update data`):t.createError(`${this._methodName}() cannot be used with set() unless you pass {merge:true}`);return t.fieldMask.push(t.path),null}isEqual(t){return t instanceof Ts}}function pf(r,t,e){return new Bi({dataSource:3,targetDoc:t.settings.targetDoc,methodName:r._methodName,arrayElement:e},t.databaseId,t.serializer,t.ignoreUndefinedProperties)}class Ha extends In{_toFieldTransform(t){return new gs(t.path,new Hn)}isEqual(t){return t instanceof Ha}}class Ja extends In{constructor(t,e){super(t),this.Ac=e}_toFieldTransform(t){const e=pf(this,t,!0),n=this.Ac.map((i=>En(i,e))),s=new ln(n);return new gs(t.path,s)}isEqual(t){return t instanceof Ja&&cs(this.Ac,t.Ac)}}class Ya extends In{constructor(t,e){super(t),this.Ac=e}_toFieldTransform(t){const e=pf(this,t,!0),n=this.Ac.map((i=>En(i,e))),s=new hn(n);return new gs(t.path,s)}isEqual(t){return t instanceof Ya&&cs(this.Ac,t.Ac)}}class Xa extends In{constructor(t,e){super(t),this.Vc=e}_toFieldTransform(t){const e=new Jn(t.serializer,Uh(t.serializer,this.Vc));return new gs(t.path,e)}isEqual(t){return t instanceof Xa&&this.Vc===t.Vc}}function Za(r,t,e,n){const s=r.createContext(1,t,e);eu("Data must be an object, but it was:",s,n);const i=[],a=vt.empty();qe(n,((c,h)=>{const f=nu(t,c,e);h=It(h);const m=s.childContextForFieldPath(f);if(h instanceof Ts)i.push(f);else{const p=En(h,m);p!=null&&(i.push(f),a.set(f,p))}}));const u=new Ot(i);return new mf(a,u,s.fieldTransforms)}function tu(r,t,e,n,s,i){const a=r.createContext(1,t,e),u=[ce(t,n,e)],c=[s];if(i.length%2!=0)throw new b(P.INVALID_ARGUMENT,`Function ${t}() needs to be called with an even number of arguments that alternate between field names and values.`);for(let p=0;p<i.length;p+=2)u.push(ce(t,i[p])),c.push(i[p+1]);const h=[],f=vt.empty();for(let p=u.length-1;p>=0;--p)if(!Tf(h,u[p])){const v=u[p];let C=c[p];C=It(C);const N=a.childContextForFieldPath(v);if(C instanceof Ts)h.push(v);else{const D=En(C,N);D!=null&&(h.push(v),f.set(v,D))}}const m=new Ot(h);return new mf(f,m,a.fieldTransforms)}function _f(r,t,e,n=!1){return En(e,r.createContext(n?4:3,t))}function En(r,t){if(If(r=It(r)))return eu("Unsupported field value:",t,r),yf(r,t);if(r instanceof In)return(function(n,s){if(!gf(s.dataSource))throw s.createError(`${n._methodName}() can only be used with update() and set()`);if(!s.path)throw s.createError(`${n._methodName}() is not currently supported inside arrays`);const i=n._toFieldTransform(s);i&&s.fieldTransforms.push(i)})(r,t),null;if(r===void 0&&t.ignoreUndefinedProperties)return null;if(t.path&&t.fieldMask.push(t.path),r instanceof Array){if(t.settings.arrayElement&&t.dataSource!==4)throw t.createError("Nested arrays are not supported");return(function(n,s){const i=[];let a=0;for(const u of n){let c=En(u,s.childContextForArray(a));c==null&&(c={nullValue:"NULL_VALUE"}),i.push(c),a++}return{arrayValue:{values:i}}})(r,t)}return(function(n,s){if((n=It(n))===null)return{nullValue:"NULL_VALUE"};if(typeof n=="number")return Uh(s.serializer,n);if(typeof n=="boolean")return{booleanValue:n};if(typeof n=="string")return{stringValue:n};if(n instanceof Date){const i=Z.fromDate(n);return{timestampValue:Yn(s.serializer,i)}}if(n instanceof Z){const i=new Z(n.seconds,1e3*Math.floor(n.nanoseconds/1e3));return{timestampValue:Yn(s.serializer,i)}}if(n instanceof re)return{geoPointValue:{latitude:n.latitude,longitude:n.longitude}};if(n instanceof Ut)return{bytesValue:td(s.serializer,n._byteString)};if(n instanceof nt){const i=s.databaseId,a=n.firestore._databaseId;if(!a.isEqual(i))throw s.createError(`Document reference is for database ${a.projectId}/${a.database} but should be for database ${i.projectId}/${i.database}`);return{referenceValue:Ta(n.firestore._databaseId||s.databaseId,n._key.path)}}if(n instanceof $t)return(function(a,u){const c=a instanceof $t?a.toArray():a;return{mapValue:{fields:{[ca]:{stringValue:la},[$n]:{arrayValue:{values:c.map((f=>{if(typeof f!="number")throw u.createError("VectorValues must only contain numeric values.");return ma(u.serializer,f)}))}}}}}})(n,s);if(hd(n))return n._toProto(s.serializer);throw s.createError(`Unsupported field value: ${Ti(n)}`)})(r,t)}function yf(r,t){const e={};return mh(r)?t.path&&t.path.length>0&&t.fieldMask.push(t.path):qe(r,((n,s)=>{const i=En(s,t.childContextForField(n));i!=null&&(e[n]=i)})),{mapValue:{fields:e}}}function If(r){return!(typeof r!="object"||r===null||r instanceof Array||r instanceof Date||r instanceof Z||r instanceof re||r instanceof Ut||r instanceof nt||r instanceof In||r instanceof $t||hd(r))}function eu(r,t,e){if(!If(e)||!Hl(e)){const n=Ti(e);throw n==="an object"?t.createError(r+" a custom object"):t.createError(r+" "+n)}}function ce(r,t,e){if((t=It(t))instanceof fr)return t._internalPath;if(typeof t=="string")return nu(r,t);throw Ii("Field path arguments must be of type string or ",r,!1,void 0,e)}const ry=new RegExp("[~\\*/\\[\\]]");function nu(r,t,e){if(t.search(ry)>=0)throw Ii(`Invalid field path (${t}). Paths must not contain '~', '*', '/', '[', or ']'`,r,!1,void 0,e);try{return new fr(...t.split("."))._internalPath}catch{throw Ii(`Invalid field path (${t}). Paths must not be empty, begin with '.', end with '.', or contain '..'`,r,!1,void 0,e)}}function Ii(r,t,e,n,s){const i=n&&!n.isEmpty(),a=s!==void 0;let u=`Function ${t}() called with invalid data`;e&&(u+=" (via `toFirestore()`)"),u+=". ";let c="";return(i||a)&&(c+=" (found",i&&(c+=` in field ${n}`),a&&(c+=` in document ${s}`),c+=")"),new b(P.INVALID_ARGUMENT,u+r+c)}function Tf(r,t){return r.some((e=>e.isEqual(t)))}/**
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
 */class Ef{convertValue(t,e="none"){switch(xe(t)){case 0:return null;case 1:return t.booleanValue;case 2:return ut(t.integerValue||t.doubleValue);case 3:return this.convertTimestamp(t.timestampValue);case 4:return this.convertServerTimestamp(t,e);case 5:return t.stringValue;case 6:return this.convertBytes(ue(t.bytesValue));case 7:return this.convertReference(t.referenceValue);case 8:return this.convertGeoPoint(t.geoPointValue);case 9:return this.convertArray(t.arrayValue,e);case 11:return this.convertObject(t.mapValue,e);case 10:return this.convertVectorValue(t.mapValue);default:throw O(62114,{value:t})}}convertObject(t,e){return this.convertObjectMap(t.fields,e)}convertObjectMap(t,e="none"){const n={};return qe(t,((s,i)=>{n[s]=this.convertValue(i,e)})),n}convertVectorValue(t){var n,s,i;const e=(i=(s=(n=t.fields)==null?void 0:n[$n].arrayValue)==null?void 0:s.values)==null?void 0:i.map((a=>ut(a.doubleValue)));return new $t(e)}convertGeoPoint(t){return new re(ut(t.latitude),ut(t.longitude))}convertArray(t,e){return(t.values||[]).map((n=>this.convertValue(n,e)))}convertServerTimestamp(t,e){switch(e){case"previous":const n=Pi(t);return n==null?null:this.convertValue(n,e);case"estimate":return this.convertTimestamp(ts(t));default:return null}}convertTimestamp(t){const e=ae(t);return new Z(e.seconds,e.nanos)}convertDocumentKey(t,e){const n=$.fromString(t);L(ld(n),9688,{name:t});const s=new an(n.get(1),n.get(3)),i=new k(n.popFirst(5));return s.isEqual(e)||mt(`Document ${i} contains a document reference within a different database (${s.projectId}/${s.database}) which is not supported. It will be treated as a reference in the current database (${e.projectId}/${e.database}) instead.`),i}}/**
 * @license
 * Copyright 2024 Google LLC
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
 */class je extends Ef{constructor(t){super(),this.firestore=t}convertBytes(t){return new Ut(t)}convertReference(t){const e=this.convertDocumentKey(t,this.firestore._databaseId);return new nt(this.firestore,null,e)}}/**
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
 */function jy(){return new Ts("deleteField")}function zy(){return new Ha("serverTimestamp")}function Gy(...r){return new Ja("arrayUnion",r)}function Ky(...r){return new Ya("arrayRemove",r)}function $y(r){return new Xa("increment",r)}function Qy(r){return new $t(r)}/**
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
 */function Wy(r){var n;const t=ht(Q(r.firestore,st)),e=(n=t._onlineComponents)==null?void 0:n.datastore.serializer;return e===void 0?null:xi(e,Dt(r._query)).ft}function Hy(r,t){var i;const e=fh(t,((a,u)=>new Wh(u,a.aggregateType,a._internalFieldPath))),n=ht(Q(r.firestore,st)),s=(i=n._onlineComponents)==null?void 0:i.datastore.serializer;return s===void 0?null:od(s,Dh(r._query),e,!0).request}const bl="@firebase/firestore",Cl="4.11.0";/**
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
 */function On(r){return(function(e,n){if(typeof e!="object"||e===null)return!1;const s=e;for(const i of n)if(i in s&&typeof s[i]=="function")return!0;return!1})(r,["next","error","complete"])}/**
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
 */class as{constructor(t="count",e){this._internalFieldPath=e,this.type="AggregateField",this.aggregateType=t}}class sy{constructor(t,e,n){this._userDataWriter=e,this._data=n,this.type="AggregateQuerySnapshot",this.query=t}data(){return this._userDataWriter.convertObjectMap(this._data)}_fieldsProto(){return new vt({mapValue:{fields:this._data}}).clone().value.mapValue.fields}}/**
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
 */class us{constructor(t,e,n,s,i){this._firestore=t,this._userDataWriter=e,this._key=n,this._document=s,this._converter=i}get id(){return this._key.path.lastSegment()}get ref(){return new nt(this._firestore,this._converter,this._key)}exists(){return this._document!==null}data(){if(this._document){if(this._converter){const t=new iy(this._firestore,this._userDataWriter,this._key,this._document,null);return this._converter.fromFirestore(t)}return this._userDataWriter.convertValue(this._document.data.value)}}_fieldsProto(){var t;return((t=this._document)==null?void 0:t.data.clone().value.mapValue.fields)??void 0}get(t){if(this._document){const e=this._document.data.field(ce("DocumentSnapshot.get",t));if(e!==null)return this._userDataWriter.convertValue(e)}}}class iy extends us{data(){return super.data()}}/**
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
 */function wf(r){if(r.limitType==="L"&&r.explicitOrderBy.length===0)throw new b(P.UNIMPLEMENTED,"limitToLast() queries require specifying at least one orderBy() clause")}class ru{}class Es extends ru{}function Jy(r,t,...e){let n=[];t instanceof ru&&n.push(t),n=n.concat(e),(function(i){const a=i.filter((c=>c instanceof mr)).length,u=i.filter((c=>c instanceof ws)).length;if(a>1||a>0&&u>0)throw new b(P.INVALID_ARGUMENT,"InvalidQuery. When using composite filters, you cannot use more than one filter at the top level. Consider nesting the multiple filters within an `and(...)` statement. For example: change `query(query, where(...), or(...))` to `query(query, and(where(...), or(...)))`.")})(n);for(const s of n)r=s._apply(r);return r}class ws extends Es{constructor(t,e,n){super(),this._field=t,this._op=e,this._value=n,this.type="where"}static _create(t,e,n){return new ws(t,e,n)}_apply(t){const e=this._parse(t);return vf(t._query,e),new Pt(t.firestore,t.converter,Bo(t._query,e))}_parse(t){const e=Tn(t.firestore);return(function(i,a,u,c,h,f,m){let p;if(h.isKeyField()){if(f==="array-contains"||f==="array-contains-any")throw new b(P.INVALID_ARGUMENT,`Invalid Query. You can't perform '${f}' queries on documentId().`);if(f==="in"||f==="not-in"){Dl(m,f);const C=[];for(const N of m)C.push(xl(c,i,N));p={arrayValue:{values:C}}}else p=xl(c,i,m)}else f!=="in"&&f!=="not-in"&&f!=="array-contains-any"||Dl(m,f),p=_f(u,a,m,f==="in"||f==="not-in");return W.create(h,f,p)})(t._query,"where",e,t.firestore._databaseId,this._field,this._op,this._value)}}function Yy(r,t,e){const n=t,s=ce("where",r);return ws._create(s,n,e)}class mr extends ru{constructor(t,e){super(),this.type=t,this._queryConstraints=e}static _create(t,e){return new mr(t,e)}_parse(t){const e=this._queryConstraints.map((n=>n._parse(t))).filter((n=>n.getFilters().length>0));return e.length===1?e[0]:tt.create(e,this._getOperator())}_apply(t){const e=this._parse(t);return e.getFilters().length===0?t:((function(s,i){let a=s;const u=i.getFlattenedFilters();for(const c of u)vf(a,c),a=Bo(a,c)})(t._query,e),new Pt(t.firestore,t.converter,Bo(t._query,e)))}_getQueryConstraints(){return this._queryConstraints}_getOperator(){return this.type==="and"?"and":"or"}}function Xy(...r){return r.forEach((t=>Rf("or",t))),mr._create("or",r)}function Zy(...r){return r.forEach((t=>Rf("and",t))),mr._create("and",r)}class su extends Es{constructor(t,e){super(),this._field=t,this._direction=e,this.type="orderBy"}static _create(t,e){return new su(t,e)}_apply(t){const e=(function(s,i,a){if(s.startAt!==null)throw new b(P.INVALID_ARGUMENT,"Invalid query. You must not call startAt() or startAfter() before calling orderBy().");if(s.endAt!==null)throw new b(P.INVALID_ARGUMENT,"Invalid query. You must not call endAt() or endBefore() before calling orderBy().");return new ss(i,a)})(t._query,this._field,this._direction);return new Pt(t.firestore,t.converter,Ag(t._query,e))}}function tI(r,t="asc"){const e=t,n=ce("orderBy",r);return su._create(n,e)}class ji extends Es{constructor(t,e,n){super(),this.type=t,this._limit=e,this._limitType=n}static _create(t,e,n){return new ji(t,e,n)}_apply(t){return new Pt(t.firestore,t.converter,li(t._query,this._limit,this._limitType))}}function eI(r){return Jl("limit",r),ji._create("limit",r,"F")}function nI(r){return Jl("limitToLast",r),ji._create("limitToLast",r,"L")}class zi extends Es{constructor(t,e,n){super(),this.type=t,this._docOrFields=e,this._inclusive=n}static _create(t,e,n){return new zi(t,e,n)}_apply(t){const e=Af(t,this.type,this._docOrFields,this._inclusive);return new Pt(t.firestore,t.converter,vg(t._query,e))}}function rI(...r){return zi._create("startAt",r,!0)}function sI(...r){return zi._create("startAfter",r,!1)}class Gi extends Es{constructor(t,e,n){super(),this.type=t,this._docOrFields=e,this._inclusive=n}static _create(t,e,n){return new Gi(t,e,n)}_apply(t){const e=Af(t,this.type,this._docOrFields,this._inclusive);return new Pt(t.firestore,t.converter,Rg(t._query,e))}}function iI(...r){return Gi._create("endBefore",r,!1)}function oI(...r){return Gi._create("endAt",r,!0)}function Af(r,t,e,n){if(e[0]=It(e[0]),e[0]instanceof us)return(function(i,a,u,c,h){if(!c)throw new b(P.NOT_FOUND,`Can't use a DocumentSnapshot that doesn't exist for ${u}().`);const f=[];for(const m of Fn(i))if(m.field.isKeyField())f.push(un(a,c.key));else{const p=c.data.field(m.field);if(Ri(p))throw new b(P.INVALID_ARGUMENT,'Invalid query. You are trying to start or end a query using a document for which the field "'+m.field+'" is an uncommitted server timestamp. (Since the value of this field is unknown, you cannot start/end a query with it.)');if(p===null){const v=m.field.canonicalString();throw new b(P.INVALID_ARGUMENT,`Invalid query. You are trying to start or end a query using a document for which the field '${v}' (used as the orderBy) does not exist.`)}f.push(p)}return new Ne(f,h)})(r._query,r.firestore._databaseId,t,e[0]._document,n);{const s=Tn(r.firestore);return(function(a,u,c,h,f,m){const p=a.explicitOrderBy;if(f.length>p.length)throw new b(P.INVALID_ARGUMENT,`Too many arguments provided to ${h}(). The number of arguments must be less than or equal to the number of orderBy() clauses`);const v=[];for(let C=0;C<f.length;C++){const N=f[C];if(p[C].field.isKeyField()){if(typeof N!="string")throw new b(P.INVALID_ARGUMENT,`Invalid query. Expected a string for document ID in ${h}(), but got a ${typeof N}`);if(!da(a)&&N.indexOf("/")!==-1)throw new b(P.INVALID_ARGUMENT,`Invalid query. When querying a collection and ordering by documentId(), the value passed to ${h}() must be a plain document ID, but '${N}' contains a slash.`);const D=a.path.child($.fromString(N));if(!k.isDocumentKey(D))throw new b(P.INVALID_ARGUMENT,`Invalid query. When querying a collection group and ordering by documentId(), the value passed to ${h}() must result in a valid document path, but '${D}' is not because it contains an odd number of segments.`);const q=new k(D);v.push(un(u,q))}else{const D=_f(c,h,N);v.push(D)}}return new Ne(v,m)})(r._query,r.firestore._databaseId,s,t,e,n)}}function xl(r,t,e){if(typeof(e=It(e))=="string"){if(e==="")throw new b(P.INVALID_ARGUMENT,"Invalid query. When querying with documentId(), you must provide a valid document ID, but it was an empty string.");if(!da(t)&&e.indexOf("/")!==-1)throw new b(P.INVALID_ARGUMENT,`Invalid query. When querying a collection by documentId(), you must provide a plain document ID, but '${e}' contains a '/' character.`);const n=t.path.child($.fromString(e));if(!k.isDocumentKey(n))throw new b(P.INVALID_ARGUMENT,`Invalid query. When querying a collection group by documentId(), the value provided must result in a valid document path, but '${n}' is not because it has an odd number of segments (${n.length}).`);return un(r,new k(n))}if(e instanceof nt)return un(r,e._key);throw new b(P.INVALID_ARGUMENT,`Invalid query. When querying with documentId(), you must provide a valid string or a DocumentReference, but it was: ${Ti(e)}.`)}function Dl(r,t){if(!Array.isArray(r)||r.length===0)throw new b(P.INVALID_ARGUMENT,`Invalid Query. A non-empty array is required for '${t.toString()}' filters.`)}function vf(r,t){const e=(function(s,i){for(const a of s)for(const u of a.getFlattenedFilters())if(i.indexOf(u.op)>=0)return u.op;return null})(r.filters,(function(s){switch(s){case"!=":return["!=","not-in"];case"array-contains-any":case"in":return["not-in"];case"not-in":return["array-contains-any","in","not-in","!="];default:return[]}})(t.op));if(e!==null)throw e===t.op?new b(P.INVALID_ARGUMENT,`Invalid query. You cannot use more than one '${t.op.toString()}' filter.`):new b(P.INVALID_ARGUMENT,`Invalid query. You cannot use '${t.op.toString()}' filters with '${e.toString()}' filters.`)}function Rf(r,t){if(!(t instanceof ws||t instanceof mr))throw new b(P.INVALID_ARGUMENT,`Function ${r}() requires AppliableConstraints created with a call to 'where(...)', 'or(...)', or 'and(...)'.`)}function Ki(r,t,e){let n;return n=r?e&&(e.merge||e.mergeFields)?r.toFirestore(t,e):r.toFirestore(t):t,n}class iu extends Ef{constructor(t){super(),this.firestore=t}convertBytes(t){return new Ut(t)}convertReference(t){const e=this.convertDocumentKey(t,this.firestore._databaseId);return new nt(this.firestore,null,e)}}/**
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
 */function aI(r){return new as("sum",ce("sum",r))}function uI(r){return new as("avg",ce("average",r))}function oy(){return new as("count")}function cI(r,t){var e,n;return r instanceof as&&t instanceof as&&r.aggregateType===t.aggregateType&&((e=r._internalFieldPath)==null?void 0:e.canonicalString())===((n=t._internalFieldPath)==null?void 0:n.canonicalString())}function lI(r,t){return hf(r.query,t.query)&&cs(r.data(),t.data())}/**
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
 */function hI(r){return ay(r,{count:oy()})}function ay(r,t){const e=Q(r.firestore,st),n=ht(e),s=fh(t,((i,a)=>new Wh(a,i.aggregateType,i._internalFieldPath)));return q_(n,r._query,s).then((i=>(function(u,c,h){const f=new je(u);return new sy(c,f,h)})(e,r,i)))}class uy{constructor(t){this.kind="memory",this._onlineComponentProvider=Fe.provider,this._offlineComponentProvider=t!=null&&t.garbageCollector?t.garbageCollector._offlineComponentProvider:{build:()=>new Ka(void 0)}}toJSON(){return{kind:this.kind}}}class cy{constructor(t){let e;this.kind="persistent",t!=null&&t.tabManager?(t.tabManager._initialize(t),e=t.tabManager):(e=my(void 0),e._initialize(t)),this._onlineComponentProvider=e._onlineComponentProvider,this._offlineComponentProvider=e._offlineComponentProvider}toJSON(){return{kind:this.kind}}}class ly{constructor(){this.kind="memoryEager",this._offlineComponentProvider=nr.provider}toJSON(){return{kind:this.kind}}}class hy{constructor(t){this.kind="memoryLru",this._offlineComponentProvider={build:()=>new Ka(t)}}toJSON(){return{kind:this.kind}}}function dI(){return new ly}function fI(r){return new hy(r==null?void 0:r.cacheSizeBytes)}function mI(r){return new uy(r)}function gI(r){return new cy(r)}class dy{constructor(t){this.forceOwnership=t,this.kind="persistentSingleTab"}toJSON(){return{kind:this.kind}}_initialize(t){this._onlineComponentProvider=Fe.provider,this._offlineComponentProvider={build:e=>new $a(e,t==null?void 0:t.cacheSizeBytes,this.forceOwnership)}}}class fy{constructor(){this.kind="PersistentMultipleTab"}toJSON(){return{kind:this.kind}}_initialize(t){this._onlineComponentProvider=Fe.provider,this._offlineComponentProvider={build:e=>new ef(e,t==null?void 0:t.cacheSizeBytes)}}}function my(r){return new dy(r==null?void 0:r.forceOwnership)}function pI(){return new fy}/**
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
 *//**
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
 */const Pf="NOT SUPPORTED";class Pe{constructor(t,e){this.hasPendingWrites=t,this.fromCache=e}isEqual(t){return this.hasPendingWrites===t.hasPendingWrites&&this.fromCache===t.fromCache}}class jt extends us{constructor(t,e,n,s,i,a){super(t,e,n,s,a),this._firestore=t,this._firestoreImpl=t,this.metadata=i}exists(){return super.exists()}data(t={}){if(this._document){if(this._converter){const e=new ri(this._firestore,this._userDataWriter,this._key,this._document,this.metadata,null);return this._converter.fromFirestore(e,t)}return this._userDataWriter.convertValue(this._document.data.value,t.serverTimestamps)}}get(t,e={}){if(this._document){const n=this._document.data.field(ce("DocumentSnapshot.get",t));if(n!==null)return this._userDataWriter.convertValue(n,e.serverTimestamps)}}toJSON(){if(this.metadata.hasPendingWrites)throw new b(P.FAILED_PRECONDITION,"DocumentSnapshot.toJSON() attempted to serialize a document with pending writes. Await waitForPendingWrites() before invoking toJSON().");const t=this._document,e={};return e.type=jt._jsonSchemaVersion,e.bundle="",e.bundleSource="DocumentSnapshot",e.bundleName=this._key.toString(),!t||!t.isValidDocument()||!t.isFoundDocument()?e:(this._userDataWriter.convertObjectMap(t.data.value.mapValue.fields,"previous"),e.bundle=(this._firestore,this.ref.path,"NOT SUPPORTED"),e)}}function _I(r,t,e){if(_n(t,jt._jsonSchema)){if(t.bundle===Pf)throw new b(P.INVALID_ARGUMENT,"The provided JSON object was created in a client environment, which is not supported.");const n=yn(r._databaseId),s=uf(t.bundle,n),i=s.t(),a=new qa(s.getMetadata(),n);for(const f of i)a.o(f);const u=a.documents;if(u.length!==1)throw new b(P.INVALID_ARGUMENT,`Expected bundle data to contain 1 document, but it contains ${u.length} documents.`);const c=Ci(n,u[0].document),h=new k($.fromString(t.bundleName));return new jt(r,new iu(r),h,c,new Pe(!1,!1),e||null)}}jt._jsonSchemaVersion="firestore/documentSnapshot/1.0",jt._jsonSchema={type:_t("string",jt._jsonSchemaVersion),bundleSource:_t("string","DocumentSnapshot"),bundleName:_t("string"),bundle:_t("string")};class ri extends jt{data(t={}){return super.data(t)}}class zt{constructor(t,e,n,s){this._firestore=t,this._userDataWriter=e,this._snapshot=s,this.metadata=new Pe(s.hasPendingWrites,s.fromCache),this.query=n}get docs(){const t=[];return this.forEach((e=>t.push(e))),t}get size(){return this._snapshot.docs.size}get empty(){return this.size===0}forEach(t,e){this._snapshot.docs.forEach((n=>{t.call(e,new ri(this._firestore,this._userDataWriter,n.key,n,new Pe(this._snapshot.mutatedKeys.has(n.key),this._snapshot.fromCache),this.query.converter))}))}docChanges(t={}){const e=!!t.includeMetadataChanges;if(e&&this._snapshot.excludesMetadataChanges)throw new b(P.INVALID_ARGUMENT,"To include metadata changes with your document changes, you must also pass { includeMetadataChanges:true } to onSnapshot().");return this._cachedChanges&&this._cachedChangesIncludeMetadataChanges===e||(this._cachedChanges=(function(s,i){if(s._snapshot.oldDocs.isEmpty()){let a=0;return s._snapshot.docChanges.map((u=>{const c=new ri(s._firestore,s._userDataWriter,u.doc.key,u.doc,new Pe(s._snapshot.mutatedKeys.has(u.doc.key),s._snapshot.fromCache),s.query.converter);return u.doc,{type:"added",doc:c,oldIndex:-1,newIndex:a++}}))}{let a=s._snapshot.oldDocs;return s._snapshot.docChanges.filter((u=>i||u.type!==3)).map((u=>{const c=new ri(s._firestore,s._userDataWriter,u.doc.key,u.doc,new Pe(s._snapshot.mutatedKeys.has(u.doc.key),s._snapshot.fromCache),s.query.converter);let h=-1,f=-1;return u.type!==0&&(h=a.indexOf(u.doc.key),a=a.delete(u.doc.key)),u.type!==1&&(a=a.add(u.doc),f=a.indexOf(u.doc.key)),{type:gy(u.type),doc:c,oldIndex:h,newIndex:f}}))}})(this,e),this._cachedChangesIncludeMetadataChanges=e),this._cachedChanges}toJSON(){if(this.metadata.hasPendingWrites)throw new b(P.FAILED_PRECONDITION,"QuerySnapshot.toJSON() attempted to serialize a document with pending writes. Await waitForPendingWrites() before invoking toJSON().");const t={};t.type=zt._jsonSchemaVersion,t.bundleSource="QuerySnapshot",t.bundleName=ea.newId(),this._firestore._databaseId.database,this._firestore._databaseId.projectId;const e=[],n=[],s=[];return this.docs.forEach((i=>{i._document!==null&&(e.push(i._document),n.push(this._userDataWriter.convertObjectMap(i._document.data.value.mapValue.fields,"previous")),s.push(i.ref.path))})),t.bundle=(this._firestore,this.query._query,t.bundleName,"NOT SUPPORTED"),t}}function yI(r,t,e){if(_n(t,zt._jsonSchema)){if(t.bundle===Pf)throw new b(P.INVALID_ARGUMENT,"The provided JSON object was created in a client environment, which is not supported.");const n=yn(r._databaseId),s=uf(t.bundle,n),i=s.t(),a=new qa(s.getMetadata(),n);for(const p of i)a.o(p);if(a.queries.length!==1)throw new b(P.INVALID_ARGUMENT,`Snapshot data expected 1 query but found ${a.queries.length} queries.`);const u=Di(a.queries[0].bundledQuery),c=a.documents;let h=new on;c.map((p=>{const v=Ci(n,p.document);h=h.add(v)}));const f=pn.fromInitialDocuments(u,h,G(),!1,!1),m=new Pt(r,e||null,u);return new zt(r,new iu(r),m,f)}}function gy(r){switch(r){case 0:return"added";case 2:case 3:return"modified";case 1:return"removed";default:return O(61501,{type:r})}}function II(r,t){return r instanceof jt&&t instanceof jt?r._firestore===t._firestore&&r._key.isEqual(t._key)&&(r._document===null?t._document===null:r._document.isEqual(t._document))&&r._converter===t._converter:r instanceof zt&&t instanceof zt&&r._firestore===t._firestore&&hf(r.query,t.query)&&r.metadata.isEqual(t.metadata)&&r._snapshot.isEqual(t._snapshot)}/**
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
 */zt._jsonSchemaVersion="firestore/querySnapshot/1.0",zt._jsonSchema={type:_t("string",zt._jsonSchemaVersion),bundleSource:_t("string","QuerySnapshot"),bundleName:_t("string"),bundle:_t("string")};const py={maxAttempts:5};/**
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
 */class _y{constructor(t,e){this._firestore=t,this._commitHandler=e,this._mutations=[],this._committed=!1,this._dataReader=Tn(t)}set(t,e,n){this._verifyNotCommitted();const s=Se(t,this._firestore),i=Ki(s.converter,e,n),a=Ui(this._dataReader,"WriteBatch.set",s._key,i,s.converter!==null,n);return this._mutations.push(a.toMutation(s._key,lt.none())),this}update(t,e,n,...s){this._verifyNotCommitted();const i=Se(t,this._firestore);let a;return a=typeof(e=It(e))=="string"||e instanceof fr?tu(this._dataReader,"WriteBatch.update",i._key,e,n,s):Za(this._dataReader,"WriteBatch.update",i._key,e),this._mutations.push(a.toMutation(i._key,lt.exists(!0))),this}delete(t){this._verifyNotCommitted();const e=Se(t,this._firestore);return this._mutations=this._mutations.concat(new ar(e._key,lt.none())),this}commit(){return this._verifyNotCommitted(),this._committed=!0,this._mutations.length>0?this._commitHandler(this._mutations):Promise.resolve()}_verifyNotCommitted(){if(this._committed)throw new b(P.FAILED_PRECONDITION,"A write batch can no longer be used after commit() has been called.")}}function Se(r,t){if((r=It(r)).firestore!==t)throw new b(P.INVALID_ARGUMENT,"Provided document reference is from a different Firestore instance.");return r}/**
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
 */class yy{constructor(t,e){this._firestore=t,this._transaction=e,this._dataReader=Tn(t)}get(t){const e=Se(t,this._firestore),n=new iu(this._firestore);return this._transaction.lookup([e._key]).then((s=>{if(!s||s.length!==1)return O(24041);const i=s[0];if(i.isFoundDocument())return new us(this._firestore,n,i.key,i,e.converter);if(i.isNoDocument())return new us(this._firestore,n,e._key,null,e.converter);throw O(18433,{doc:i})}))}set(t,e,n){const s=Se(t,this._firestore),i=Ki(s.converter,e,n),a=Ui(this._dataReader,"Transaction.set",s._key,i,s.converter!==null,n);return this._transaction.set(s._key,a),this}update(t,e,n,...s){const i=Se(t,this._firestore);let a;return a=typeof(e=It(e))=="string"||e instanceof fr?tu(this._dataReader,"Transaction.update",i._key,e,n,s):Za(this._dataReader,"Transaction.update",i._key,e),this._transaction.update(i._key,a),this}delete(t){const e=Se(t,this._firestore);return this._transaction.delete(e._key),this}}/**
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
 */class Iy extends yy{constructor(t,e){super(t,e),this._firestore=t}get(t){const e=Se(t,this._firestore),n=new je(this._firestore);return super.get(t).then((s=>new jt(this._firestore,n,e._key,s._document,new Pe(!1,!1),e.converter)))}}function TI(r,t,e){r=Q(r,st);const n={...py,...e};(function(a){if(a.maxAttempts<1)throw new b(P.INVALID_ARGUMENT,"Max attempts must be at least 1")})(n);const s=ht(r);return j_(s,(i=>t(new Iy(r,i))),n)}/**
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
 */function EI(r){r=Q(r,nt);const t=Q(r.firestore,st),e=ht(t);return of(e,r._key).then((n=>ou(t,r,n)))}function wI(r){r=Q(r,nt);const t=Q(r.firestore,st),e=ht(t),n=new je(t);return O_(e,r._key).then((s=>new jt(t,n,r._key,s,new Pe(s!==null&&s.hasLocalMutations,!0),r.converter)))}function AI(r){r=Q(r,nt);const t=Q(r.firestore,st),e=ht(t);return of(e,r._key,{source:"server"}).then((n=>ou(t,r,n)))}function vI(r){r=Q(r,Pt);const t=Q(r.firestore,st),e=ht(t),n=new je(t);return wf(r._query),af(e,r._query).then((s=>new zt(t,n,r,s)))}function RI(r){r=Q(r,Pt);const t=Q(r.firestore,st),e=ht(t),n=new je(t);return L_(e,r._query).then((s=>new zt(t,n,r,s)))}function PI(r){r=Q(r,Pt);const t=Q(r.firestore,st),e=ht(t),n=new je(t);return af(e,r._query,{source:"server"}).then((s=>new zt(t,n,r,s)))}function SI(r,t,e){r=Q(r,nt);const n=Q(r.firestore,st),s=Ki(r.converter,t,e),i=Tn(n);return As(n,[Ui(i,"setDoc",r._key,s,r.converter!==null,e).toMutation(r._key,lt.none())])}function VI(r,t,e,...n){r=Q(r,nt);const s=Q(r.firestore,st),i=Tn(s);let a;return a=typeof(t=It(t))=="string"||t instanceof fr?tu(i,"updateDoc",r._key,t,e,n):Za(i,"updateDoc",r._key,t),As(s,[a.toMutation(r._key,lt.exists(!0))])}function bI(r){return As(Q(r.firestore,st),[new ar(r._key,lt.none())])}function CI(r,t){const e=Q(r.firestore,st),n=Y_(r),s=Ki(r.converter,t),i=Tn(r.firestore);return As(e,[Ui(i,"addDoc",n._key,s,r.converter!==null,{}).toMutation(n._key,lt.exists(!1))]).then((()=>n))}function Nl(r,...t){var h,f,m;r=It(r);let e={includeMetadataChanges:!1,source:"default"},n=0;typeof t[n]!="object"||On(t[n])||(e=t[n++]);const s={includeMetadataChanges:e.includeMetadataChanges,source:e.source};if(On(t[n])){const p=t[n];t[n]=(h=p.next)==null?void 0:h.bind(p),t[n+1]=(f=p.error)==null?void 0:f.bind(p),t[n+2]=(m=p.complete)==null?void 0:m.bind(p)}let i,a,u;if(r instanceof nt)a=Q(r.firestore,st),u=ir(r._key.path),i={next:p=>{t[n]&&t[n](ou(a,r,p))},error:t[n+1],complete:t[n+2]};else{const p=Q(r,Pt);a=Q(p.firestore,st),u=p._query;const v=new je(a);i={next:C=>{t[n]&&t[n](new zt(a,v,p,C))},error:t[n+1],complete:t[n+2]},wf(r._query)}const c=ht(a);return M_(c,u,s,i)}function xI(r,t,...e){const n=It(r),s=(function(c){const h={bundle:"",bundleName:"",bundleSource:""},f=["bundle","bundleName","bundleSource"];for(const m of f){if(!(m in c)){h.error=`snapshotJson missing required field: ${m}`;break}const p=c[m];if(typeof p!="string"){h.error=`snapshotJson field '${m}' must be a string.`;break}if(p.length===0){h.error=`snapshotJson field '${m}' cannot be an empty string.`;break}m==="bundle"?h.bundle=p:m==="bundleName"?h.bundleName=p:m==="bundleSource"&&(h.bundleSource=p)}return h})(t);if(s.error)throw new b(P.INVALID_ARGUMENT,s.error);let i,a=0;if(typeof e[a]!="object"||On(e[a])||(i=e[a++]),s.bundleSource==="QuerySnapshot"){let u=null;if(typeof e[a]=="object"&&On(e[a])){const c=e[a++];u={next:c.next,error:c.error,complete:c.complete}}else u={next:e[a++],error:e[a++],complete:e[a++]};return(function(h,f,m,p,v){let C,N=!1;return Vl(h,f.bundle).then((()=>Z_(h,f.bundleName))).then((q=>{q&&!N&&(v&&q.withConverter(v),C=Nl(q,m||{},p))})).catch((q=>(p.error&&p.error(q),()=>{}))),()=>{N||(N=!0,C&&C())}})(n,s,i,u,e[a])}if(s.bundleSource==="DocumentSnapshot"){let u=null;if(typeof e[a]=="object"&&On(e[a])){const c=e[a++];u={next:c.next,error:c.error,complete:c.complete}}else u={next:e[a++],error:e[a++],complete:e[a++]};return(function(h,f,m,p,v){let C,N=!1;return Vl(h,f.bundle).then((()=>{if(!N){const q=new nt(h,v||null,k.fromPath(f.bundleName));C=Nl(q,m||{},p)}})).catch((q=>(p.error&&p.error(q),()=>{}))),()=>{N||(N=!0,C&&C())}})(n,s,i,u,e[a])}throw new b(P.INVALID_ARGUMENT,`unsupported bundle source: ${s.bundleSource}`)}function DI(r,t){r=Q(r,st);const e=ht(r),n=On(t)?t:{next:t};return U_(e,n)}function As(r,t){const e=ht(r);return B_(e,t)}function ou(r,t,e){const n=e.docs.get(t._key),s=new je(r);return new jt(r,s,t._key,n,new Pe(e.hasPendingWrites,e.fromCache),t.converter)}function NI(r){return r=Q(r,st),ht(r),new _y(r,(t=>As(r,t)))}/**
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
 */function kI(r,t){r=Q(r,st);const e=ht(r);if(!e._uninitializedComponentsProvider||e._uninitializedComponentsProvider._offline.kind==="memory")return Gt("Cannot enable indexes when persistence is disabled"),Promise.resolve();const n=(function(i){const a=typeof i=="string"?(function(h){try{return JSON.parse(h)}catch(f){throw new b(P.INVALID_ARGUMENT,"Failed to parse JSON: "+(f==null?void 0:f.message))}})(i):i,u=[];if(Array.isArray(a.indexes))for(const c of a.indexes){const h=kl(c,"collectionGroup"),f=[];if(Array.isArray(c.fields))for(const m of c.fields){const p=kl(m,"fieldPath"),v=nu("setIndexConfiguration",p);m.arrayConfig==="CONTAINS"?f.push(new rn(v,2)):m.order==="ASCENDING"?f.push(new rn(v,0)):m.order==="DESCENDING"&&f.push(new rn(v,1))}u.push(new Bn(Bn.UNKNOWN_ID,h,f,Un.empty()))}return u})(t);return K_(e,n)}function kl(r,t){if(typeof r[t]!="string")throw new b(P.INVALID_ARGUMENT,"Missing string value for: "+t);return r[t]}/**
 * @license
 * Copyright 2023 Google LLC
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
 */class Ty{constructor(t){this._firestore=t,this.type="PersistentCacheIndexManager"}}function FI(r){var s;r=Q(r,st);const t=Fl.get(r);if(t)return t;if(((s=ht(r)._uninitializedComponentsProvider)==null?void 0:s._offline.kind)!=="persistent")return null;const n=new Ty(r);return Fl.set(r,n),n}function MI(r){Sf(r,!0)}function OI(r){Sf(r,!1)}function LI(r){const t=ht(r._firestore);Q_(t).then((e=>x("deleting all persistent cache indexes succeeded"))).catch((e=>Gt("deleting all persistent cache indexes failed",e)))}function Sf(r,t){const e=ht(r._firestore);$_(e,t).then((n=>x(`setting persistent cache index auto creation isEnabled=${t} succeeded`))).catch((n=>Gt(`setting persistent cache index auto creation isEnabled=${t} failed`,n)))}const Fl=new WeakMap;/**
 * @license
 * Copyright 2023 Google LLC
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
 */class qI{constructor(){throw new Error("instances of this class should not be created")}static onExistenceFilterMismatch(t){return au.instance.onExistenceFilterMismatch(t)}}class au{constructor(){this.i=new Map}static get instance(){return $s||($s=new au,Lg($s)),$s}u(t){this.i.forEach((e=>e(t)))}onExistenceFilterMismatch(t){const e=Symbol(),n=this.i;return n.set(e,t),()=>n.delete(e)}}let $s=null;(function(t,e=!0){Im(ym),pm(new _m("firestore",((n,{instanceIdentifier:s,options:i})=>{const a=n.getProvider("app").getImmediate(),u=new st(new wm(n.getProvider("auth-internal")),new Rm(a,n.getProvider("app-check-internal")),hg(a,s),a);return i={useFetchStreams:e,...i},u._setSettings(i),u}),"PUBLIC").setMultipleInstances(!0)),cc(bl,Cl,t),cc(bl,Cl,"esm2020")})();export{Ef as AbstractUserDataWriter,as as AggregateField,sy as AggregateQuerySnapshot,Ut as Bytes,xy as CACHE_SIZE_UNLIMITED,ne as CollectionReference,nt as DocumentReference,jt as DocumentSnapshot,fr as FieldPath,In as FieldValue,st as Firestore,b as FirestoreError,re as GeoPoint,X_ as LoadBundleTask,Ty as PersistentCacheIndexManager,Pt as Query,mr as QueryCompositeFilterConstraint,Es as QueryConstraint,ri as QueryDocumentSnapshot,Gi as QueryEndAtConstraint,ws as QueryFieldFilterConstraint,ji as QueryLimitConstraint,su as QueryOrderByConstraint,zt as QuerySnapshot,zi as QueryStartAtConstraint,Pe as SnapshotMetadata,Z as Timestamp,Iy as Transaction,$t as VectorValue,_y as WriteBatch,ea as _AutoId,ft as _ByteString,an as _DatabaseId,k as _DocumentKey,vy as _EmptyAppCheckTokenProvider,Tm as _EmptyAuthCredentialsProvider,ct as _FieldPath,qI as _TestingHooks,Q as _cast,Ay as _debugAssert,Hy as _internalAggregationQueryToProtoRunAggregationQueryRequest,Wy as _internalQueryToProtoQueryTarget,Py as _isBase64Available,Gt as _logWarn,Cm as _validateIsNotUsedTogether,CI as addDoc,cI as aggregateFieldEqual,lI as aggregateQuerySnapshotEqual,Zy as and,Ky as arrayRemove,Gy as arrayUnion,uI as average,My as clearIndexedDbPersistence,Vy as collection,by as collectionGroup,J_ as connectFirestoreEmulator,oy as count,LI as deleteAllPersistentCacheIndexes,bI as deleteDoc,jy as deleteField,qy as disableNetwork,OI as disablePersistentCacheIndexAutoCreation,Y_ as doc,Uy as documentId,_I as documentSnapshotFromJSON,ky as enableIndexedDbPersistence,Fy as enableMultiTabIndexedDbPersistence,Ly as enableNetwork,MI as enablePersistentCacheIndexAutoCreation,oI as endAt,iI as endBefore,ht as ensureFirestoreConfigured,As as executeWrite,ay as getAggregateFromServer,hI as getCountFromServer,EI as getDoc,wI as getDocFromCache,AI as getDocFromServer,vI as getDocs,RI as getDocsFromCache,PI as getDocsFromServer,Ny as getFirestore,FI as getPersistentCacheIndexManager,$y as increment,Dy as initializeFirestore,eI as limit,nI as limitToLast,Vl as loadBundle,dI as memoryEagerGarbageCollector,mI as memoryLocalCache,fI as memoryLruGarbageCollector,Z_ as namedQuery,Nl as onSnapshot,xI as onSnapshotResume,DI as onSnapshotsInSync,Xy as or,tI as orderBy,gI as persistentLocalCache,pI as persistentMultipleTabManager,my as persistentSingleTabManager,Jy as query,hf as queryEqual,yI as querySnapshotFromJSON,Cy as refEqual,TI as runTransaction,zy as serverTimestamp,SI as setDoc,kI as setIndexConfiguration,wy as setLogLevel,II as snapshotEqual,sI as startAfter,rI as startAt,aI as sum,By as terminate,VI as updateDoc,Qy as vector,Oy as waitForPendingWrites,Yy as where,NI as writeBatch};
