export type RecaptchaLikeWindow = Window & {
 grecaptcha?: {
 ready?: (callback: () => void) => void;
 enterprise?: {
 ready?: (callback: () => void) => void;
 };
 };
};

export function isRecaptchaClientReady(target: RecaptchaLikeWindow | undefined): boolean {
 if (!target?.grecaptcha) return false;
 return (
 typeof target.grecaptcha.enterprise?.ready === 'function' ||
 typeof target.grecaptcha.ready === 'function'
 );
}
