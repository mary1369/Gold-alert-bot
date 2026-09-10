exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Bot is running on Netlify Functions!" }),
  };
};
