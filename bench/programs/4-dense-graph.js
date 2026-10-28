// Stress 4: a graph of 400 nodes and about 2,400 edges (each node linked
// to 6 others, pseudo-randomly), then a breadth-first search. Graph layout
// and edge routing do the most work here.
const N = 400;
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const graph = {};
for (let v = 0; v < N; v++) graph[v] = [];
for (let v = 0; v < N; v++) {
  for (let k = 0; k < 6; k++) {
    const w = Math.floor(rand() * N);
    if (w !== v && !graph[v].includes(w)) graph[v].push(w);
  }
}

const dist = { 0: 0 };
const queue = [0];
while (queue.length) {
  const v = queue.shift();
  for (const w of graph[v]) {
    if (!(w in dist)) {
      dist[w] = dist[v] + 1;
      queue.push(w);
    }
  }
}
console.log(Object.keys(dist).length);
