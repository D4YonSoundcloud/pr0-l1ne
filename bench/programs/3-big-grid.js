// Stress 3: a 60 x 60 grid (3,600 cells) filled by dynamic programming:
// the longest common subsequence of two 59-letter strings. In Nested mode
// it's one grid; in Arrows mode, 60 row boxes.
const a = "ACGTTGCAAGTCCGATAGCTTAGGCATCGATCGGATCCATGCAATGCGTACCGTAGCAT";
const b = "TGCATCGGATACGTTAGCCATGCAGTCGATTGCAACGGTAGCTAGCCATGCGATACGTA";
// viz: heatmap dp
const dp = [];
for (let i = 0; i <= a.length; i++) dp.push(new Array(b.length + 1).fill(0));
for (let i = 1; i <= a.length; i++) {
  for (let j = 1; j <= b.length; j++) {
    if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
    else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
}
console.log(dp[a.length][b.length]);
