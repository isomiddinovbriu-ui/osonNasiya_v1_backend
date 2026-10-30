function withPaymentBalances(totalPrice, payments) {
  let remainingBalance = totalPrice;
  return payments.map((payment) => {
    if (payment.status === 'voided') return { ...payment, remainingBalanceAfter: null };
    remainingBalance -= payment.amount;
    return { ...payment, remainingBalanceAfter: remainingBalance };
  });
}

module.exports = { withPaymentBalances };
