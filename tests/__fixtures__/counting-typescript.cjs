const ts = require('typescript');

module.exports = new Proxy(ts, {
  get(target, property) {
    if (property === 'createSourceFile') {
      return (...args) => {
        globalThis.__articleSourceParsePaths?.push(args[0]);
        return target.createSourceFile(...args);
      };
    }
    return Reflect.get(target, property, target);
  },
});
