const processPayment = async (paymentDetails) => {
  const { amount, currency = "USD", method = "credit_card", orderId } = paymentDetails;

  if (!amount || amount <= 0) {
    throw new Error("Invalid payment amount");
  }

  if (!orderId) {
    throw new Error("Order ID is required");
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));

  // const isSuccess = Math.random() > 0.1;

  // if (!isSuccess) {
  //   return {
  //     success: false,
  //     error: "Payment declined by processor",
  //     orderId,
  //     timestamp: new Date().toISOString(),
  //   };
  // }

  const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

  return {
    success: true,
    transactionId,
    orderId,
    amount,
    currency,
    method,
    timestamp: new Date().toISOString(),
  };
};

export default processPayment;