function balanceSnapshot(customer) {
  return {
    downPayment: customer.downPayment,
    totalPaid: customer.totalPaid,
    remainingBalance: customer.remainingBalance,
  };
}

function paymentSnapshot(payment) {
  return {
    paymentId: payment._id.toString(),
    type: payment.type,
    amount: payment.amount,
    method: payment.method,
    receivedBy: payment.receivedBy?.toString() ?? null,
    dailyPlanId: payment.dailyPlanId?.toString() ?? null,
    paidAt: payment.paidAt,
    forMonth: payment.forMonth ?? null,
    allocations: payment.allocations ?? [],
    cardLast4: payment.cardLast4 ?? null,
    provider: payment.provider ?? null,
    providerName: payment.providerName ?? null,
    status: payment.status ?? 'active',
    voidedAt: payment.voidedAt ?? null,
    voidedBy: payment.voidedBy?.toString() ?? null,
    voidReason: payment.voidReason ?? null,
  };
}

function auditEntry({ action, customer, payment, actor, createdAt, before = null, after = null, reason = null }) {
  return {
    action,
    entityType: payment ? 'payment' : 'customer',
    entityId: payment ? payment._id : customer._id,
    customerId: customer._id,
    mijoz_id: customer.mijoz_id,
    actorId: actor._id,
    actorRole: actor.role,
    actorName: actor.name ?? null,
    createdAt,
    reason,
    before,
    after,
  };
}

function publicAudit(entry) {
  return {
    id: entry._id.toString(),
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId.toString(),
    mijoz_id: entry.mijoz_id,
    actorId: entry.actorId.toString(),
    actorRole: entry.actorRole,
    actorName: entry.actorName,
    createdAt: entry.createdAt,
    reason: entry.reason,
    before: entry.before,
    after: entry.after,
  };
}

module.exports = { balanceSnapshot, paymentSnapshot, auditEntry, publicAudit };
