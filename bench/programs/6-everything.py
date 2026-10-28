# Stress 6 (Python): everything at once, the kind of program LOD is for.
# A dict of 300 customer records, each with a list of orders; an index
# from city to customers (lots of aliasing); a 40 x 40 distance grid.
import random
random.seed(1)

cities = ["London", "Paris", "Austin", "Oslo", "Lima", "Pune", "Kyiv", "Accra"]
customers = {}
for cid in range(300):
    orders = [{"id": cid * 10 + k, "total": random.randint(5, 500)} for k in range(random.randint(1, 5))]
    customers[cid] = {"name": f"c{cid}", "city": random.choice(cities), "orders": orders}

by_city = {}
for cid, c in customers.items():
    by_city.setdefault(c["city"], []).append(c)   # the same dicts, a second way in

n = 40
dist = [[0 if i == j else random.randint(1, 99) for j in range(n)] for i in range(n)]
for k in range(n):
    for i in range(n):
        for j in range(n):
            if dist[i][k] + dist[k][j] < dist[i][j]:
                dist[i][j] = dist[i][k] + dist[k][j]

spent = {city: sum(o["total"] for c in people for o in c["orders"]) for city, people in by_city.items()}
print(max(spent, key=spent.get))
