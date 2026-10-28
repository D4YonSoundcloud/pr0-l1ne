# Stress 5: recursion 400 calls deep (a frame box for each call on the
# stack), and many small objects alive at once: each call makes a list
# that the next call points to.
import sys
sys.setrecursionlimit(2000)

def build(depth, parent):
    here = [depth, parent]
    if depth == 0:
        return here
    return build(depth - 1, here)

last = build(400, None)
length = 0
at = last
while at:
    length += 1
    at = at[1]
print(length)
