const fun = async () => {
    try {
        const res = await fetch("https://rmcs-backend-j87d.onrender.com/api/admin/cloudflare-usage", {
            headers: {
                "Authorization": `Bearer codewithchai0605`,
            }
        });
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2))
    } catch (error) {
        console.log(error)
    }
}

fun()