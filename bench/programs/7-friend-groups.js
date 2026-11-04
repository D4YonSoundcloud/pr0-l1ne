// Stress 7: a graph of 300 node objects, people in 12 friend groups (each
// person linked to a few in their own group, now and then to someone in
// another), then a breadth-first search from one person. Over the detail
// budget, the graph is drawn as clusters (scene/graphClusters.ts).
class Person {
  constructor(id) {
    this.id = id;
    this.friends = [];
  }
}

const N = 300;
const GROUPS = 12;
let seed = 11;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const people = [];
for (let i = 0; i < N; i++) people.push(new Person(i));
const link = (a, b) => {
  if (a === b || a.friends.includes(b)) return;
  a.friends.push(b);
  b.friends.push(a);
};
for (const p of people) {
  const group = p.id % GROUPS;
  for (let k = 0; k < 3; k++) {
    const other = people[(Math.floor(rand() * (N / GROUPS)) * GROUPS + group) % N];
    link(p, other);
  }
  if (rand() < 0.08) link(p, people[Math.floor(rand() * N)]);
}

const seen = new Set([people[0]]);
const queue = [people[0]];
while (queue.length) {
  const p = queue.shift();
  for (const f of p.friends) {
    if (!seen.has(f)) {
      seen.add(f);
      queue.push(f);
    }
  }
}
console.log(seen.size);
