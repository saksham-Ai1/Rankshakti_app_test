export default function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      message: "API working 🚀"
    });
  }

  if (req.method === 'POST') {
    return res.status(200).json({
      success: true
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
