export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { model, message, temperature } = req.body;

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.NVIDIA_NIM_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: message }],
      temperature: temperature ?? 0.7
    })
  });

  const data = await response.json();
  if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });

  res.status(200).json({ reply: data.choices[0].message.content });
}