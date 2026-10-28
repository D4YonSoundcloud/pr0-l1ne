# Stress 4: a graph of 400 nodes and about 2,400 edges (each node linked
# to 6 others, pseudo-randomly), then a breadth-first search.
from collections import deque
import random
random.seed(7)

N = 400
graph = {v: [] for v in range(N)}
for v in range(N):
    for _ in range(6):
        w = random.randrange(N)
        if w != v and w not in graph[v]:
            graph[v].append(w)

dist = {0: 0}
queue = deque([0])
while queue:
    v = queue.popleft()
    for w in graph[v]:
        if w not in dist:
            dist[w] = dist[v] + 1
            queue.append(w)
print(len(dist))
