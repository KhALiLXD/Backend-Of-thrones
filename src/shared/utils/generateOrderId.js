const generateOrderId = () => {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ORD-${timestamp}-${randomPart}`;
};

export default generateOrderId;