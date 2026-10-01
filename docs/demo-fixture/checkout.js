// A deliberately broken script, for recording the README demo.
// Run it with: node docs/demo-fixture/checkout.js
// It throws a realistic stack trace to point glance at.

function applyDiscount(order, percent) {
  return order.total.toFixed(2) * (1 - percent / 100);
}

function summarise(orders) {
  return orders.map((o) => ({ id: o.id, due: applyDiscount(o, o.discount) }));
}

const orders = [
  { id: "A-1041", total: 240.0, discount: 10 },
  { id: "A-1042", total: 99.5, discount: 5 },
  { id: "A-1043", discount: 15 },   // total is missing
];

console.log(summarise(orders));
