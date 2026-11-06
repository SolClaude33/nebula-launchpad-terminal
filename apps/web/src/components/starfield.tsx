"use client";

import { useEffect, useRef } from "react";

const VERT = `
attribute vec3 a_pos;     // x, y en [-1,1], z = profundidad (0.15..1)
attribute vec3 a_meta;    // tamaño, fase, tinte
uniform float u_time;
uniform float u_warp;
uniform vec2 u_res;
uniform vec2 u_pointer;
varying float v_alpha;
varying float v_tint;
void main() {
  float z = a_pos.z;
  float ang = u_time * 0.006 * (0.4 + z);
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 p = rot * a_pos.xy;
  p += u_pointer * 0.018 * z;
  p *= 1.0 + u_warp * (1.6 + z * 2.4);
  gl_Position = vec4(p, 0.0, 1.0);
  float tw = 0.65 + 0.35 * sin(u_time * (0.6 + a_meta.y * 1.7) + a_meta.y * 40.0);
  v_alpha = tw * (0.25 + z * 0.75) * (1.0 - u_warp * 0.6);
  v_tint = a_meta.z;
  gl_PointSize = a_meta.x * (0.6 + z * 1.6) * (1.0 + u_warp * 3.0) * (u_res.y / 900.0 + 0.4);
}`;

const FRAG = `
precision mediump float;
varying float v_alpha;
varying float v_tint;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = smoothstep(0.5, 0.0, d);
  float glow = exp(-d * 9.0);
  vec3 white = vec3(0.91, 0.93, 1.0);
  vec3 violet = vec3(0.66, 0.58, 1.0);
  vec3 cyan = vec3(0.55, 0.9, 1.0);
  vec3 col = v_tint < 0.5 ? mix(white, violet, v_tint * 2.0) : mix(white, cyan, (v_tint - 0.5) * 2.0);
  float a = (core * 0.55 + glow * 0.7) * v_alpha;
  gl_FragColor = vec4(col * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

type Props = {
  className?: string;
  density?: number;
  /** 0 → 1: acelera hacia fuera (transición al desbloquear) */
  warp?: boolean;
};

export function Starfield({ className, density = 1, warp = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const warpRef = useRef(warp);
  useEffect(() => {
    warpRef.current = warp;
  }, [warp]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) return; // sin WebGL: queda el degradado CSS de fondo

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const count = Math.round(1300 * density);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const pos = new Float32Array(count * 3);
    const meta = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // ligera concentración en una banda diagonal (vía láctea)
      const band = rand() < 0.35;
      const t = rand() * 2 - 1;
      const x = band ? t * 1.5 : rand() * 3 - 1.5;
      const y = band ? t * 0.55 + (rand() - 0.5) * 0.35 : rand() * 3 - 1.5;
      pos.set([x, y, 0.15 + Math.pow(rand(), 2.2) * 0.85], i * 3);
      const r = rand();
      meta.set([1 + Math.pow(rand(), 6) * 5, rand(), r < 0.7 ? 0.5 : r < 0.85 ? 0.15 : 0.9], i * 3);
    }

    const bind = (data: Float32Array, name: string) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    };
    bind(pos, "a_pos");
    bind(meta, "a_meta");

    const uTime = gl.getUniformLocation(prog, "u_time");
    const uWarp = gl.getUniformLocation(prog, "u_warp");
    const uRes = gl.getUniformLocation(prog, "u_res");
    const uPointer = gl.getUniformLocation(prog, "u_pointer");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    if (!reduce) window.addEventListener("pointermove", onMove);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let warpVal = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const t = (now - start) / 1000 + 30;
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      warpVal += ((warpRef.current ? 1 : 0) - warpVal) * 0.06;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, t);
      gl.uniform1f(uWarp, reduce ? 0 : warpVal);
      gl.uniform2f(uPointer, pointer.x, pointer.y);
      gl.drawArrays(gl.POINTS, 0, count);
      if (!reduce && !document.hidden) raf = requestAnimationFrame(draw);
    };
    const onVis = () => {
      if (!document.hidden && !reduce) raf = requestAnimationFrame(draw);
    };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
      // No usar loseContext(): en Strict Mode el efecto se vuelve a montar sobre el mismo canvas.
      gl.deleteProgram(prog);
    };
  }, [density]);

  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
