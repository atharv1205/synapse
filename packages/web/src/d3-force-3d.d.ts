/**
 * `d3-force-3d` ships no type declarations and has no @types package, so this
 * declares just the surface the layout uses rather than taking on a dependency.
 */
declare module "d3-force-3d" {
  export interface SimNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimLink<N> {
    source: string | number | N;
    target: string | number | N;
  }

  export interface Force {
    (alpha: number): void;
    initialize?: (nodes: SimNode[], ...rest: unknown[]) => void;
  }

  export interface LinkForce<N, L> extends Force {
    links(links: L[]): this;
    id(accessor: (node: N, index: number, nodes: N[]) => string): this;
    distance(value: number | ((link: L) => number)): this;
    strength(value: number | ((link: L) => number)): this;
  }

  export interface ManyBodyForce extends Force {
    strength(value: number | ((node: SimNode) => number)): this;
    distanceMax(value: number): this;
    theta(value: number): this;
  }

  export interface CenterForce extends Force {
    strength(value: number): this;
  }

  export interface Simulation<N extends SimNode> {
    nodes(): N[];
    nodes(nodes: N[]): this;
    force(name: string, force: Force | null): this;
    alpha(value: number): this;
    alphaDecay(value: number): this;
    alphaMin(value: number): this;
    velocityDecay(value: number): this;
    numDimensions(value: number): this;
    tick(iterations?: number): this;
    stop(): this;
  }

  export function forceSimulation<N extends SimNode>(nodes?: N[], numDimensions?: number): Simulation<N>;
  export function forceLink<N, L>(links?: L[]): LinkForce<N, L>;
  export function forceManyBody(): ManyBodyForce;
  export function forceCenter(x?: number, y?: number, z?: number): CenterForce;
}
