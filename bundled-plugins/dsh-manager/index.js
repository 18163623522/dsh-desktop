/**
 * dsh-manager — node half.
 *
 * 纯客户端插件：宿主半边为空实现，仅用于把 bundle 挂载为 profile layer，
 * 让 dsh.client 声明把浏览器半边（client.js）交给 web 前端加载。
 */
const name = "dsh-manager";
const inject = [];

function apply() {}

export { apply, inject, name };
